const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// Endpoint para recibir webhooks de GitHub
app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  const payload = req.body;

  if (event === 'pull_request' && (payload.action === 'opened' || payload.action === 'synchronize')) {
    const prNumber = payload.pull_request.number;
    const repo = payload.repository.name;
    const owner = payload.repository.owner.login;

    console.log(`Revisión de PR #${prNumber} en ${owner}/${repo}`);

    const githubToken = process.env.GITHUB_TOKEN;

    const headers = {
      Authorization: `token ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
    };

    try {
      const filesResponse = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`,
        { headers }
      );

      const archivos = filesResponse.data;

      for (const archivo of archivos) {
        const nombreArchivo = archivo.filename;
        const patch = archivo.patch;

        if (!patch) continue; // Saltar archivos binarios o sin cambios visibles

        const prompt = `
Actúa como un desarrollador senior. Revisa el siguiente fragmento de código en el archivo ${nombreArchivo}.
Sugiere mejoras sobre buenas prácticas, legibilidad y escalabilidad. Agrega TODOs si es necesario:

${patch}
`;

        const openaiResponse = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
          }
        );

        const comentarios = openaiResponse.data.choices[0].message.content;

        await axios.post(
          `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
          { body: `💡 Revisión del archivo **${nombreArchivo}**:\n\n${comentarios}` },
          { headers }
        );
      }
    } catch (error) {
      console.error('Error al procesar revisión con IA:', error.message);
    }

    return res.status(200).send({ message: 'PR recibido. Revisión en proceso...' });
  }

  res.status(200).send({ message: 'Evento recibido, no relevante para revisión.' });
});

// Endpoint para procesar contexto MCP manual
app.post('/mcp/context', async (req, res) => {
  const {
    project_name,
    repo_url,
    current_task,
    context_files,
    user_notes,
    last_model_action
  } = req.body;

  if (!context_files || !Array.isArray(context_files)) {
    return res.status(400).json({ error: 'context_files debe ser un arreglo con nombres de archivos' });
  }

  try {
    const githubToken = process.env.GITHUB_TOKEN;
    const headers = {
      Authorization: `token ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
    };

    const prompts = [];

    for (const file of context_files) {
      try {
        const path = file.replace(/^\/+/, '');
        const [owner, repo] = repo_url.split('/').slice(-2);
        const fileResponse = await axios.get(
          `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
          { headers }
        );

        const content = Buffer.from(fileResponse.data.content, 'base64').toString('utf8');

        const prompt = `
Proyecto: ${project_name}
Repositorio: ${repo_url}
Tarea actual: ${current_task}
Notas del usuario: ${user_notes}
Última acción del modelo: ${last_model_action}
Archivo: ${file}

Contenido del archivo:
${content}

👉 Revisa el contenido del archivo y sugiere mejoras sobre buenas prácticas, legibilidad y escalabilidad. Agrega TODOs si es necesario.
        `;
        prompts.push(prompt);
      } catch (err) {
        console.warn(`No se pudo obtener el archivo ${file}:`, err.message);
      }
    }

    const results = [];

    for (const prompt of prompts) {
      const openaiResponse = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
        }
      );

      results.push(openaiResponse.data.choices[0].message.content);
    }

    res.json({ results });

    if (req.body.create_pr) {
      const simpleGit = require('simple-git');
      const { execSync } = require('child_process');
      const fs = require('fs');
      const path = require('path');
      const tmp = require('os').tmpdir();
      const timestamp = Date.now();
      const branchName = `mcp-review-${timestamp}`;
      const [owner, repo] = repo_url.split('/').slice(-2);
      const localPath = path.join(tmp, `${repo}-${timestamp}`);

      try {
        execSync(`git clone https://github.com/${owner}/${repo}.git ${localPath}`);
        const git = simpleGit(localPath);

        await git.checkoutLocalBranch(branchName);

        for (let i = 0; i < context_files.length; i++) {
          const filePath = path.join(localPath, context_files[i]);
          if (!fs.existsSync(filePath)) continue;

          const original = fs.readFileSync(filePath, 'utf8');
          const updated = original + `\n\n// TODOs sugeridos por IA:\n// ${results[i].replace(/\n/g, '\n// ')}`;
          fs.writeFileSync(filePath, updated, 'utf8');
        }

        await git.add('.');
        await git.commit('chore: agregar TODOs sugeridos por IA (MCP)');
        await git.push('origin', branchName);

        const prResponse = await axios.post(
          `https://api.github.com/repos/${owner}/${repo}/pulls`,
          {
            title: `Revisión MCP - ${new Date().toISOString()}`,
            head: branchName,
            base: 'main',
            body: results.map((r, i) => `### ${context_files[i]}\n\n${r}`).join('\n\n---\n\n')
          },
          { headers }
        );

        console.log('PR creado con éxito:', prResponse.data.html_url);
      } catch (prError) {
        console.error('Error al crear PR automático:', prError.message);
      }
    }
  } catch (error) {
    console.error('Error al procesar MCP:', error.message);
    res.status(500).json({ error: 'Error interno al procesar contexto' });
  }
});

// Ruta base
app.get('/', (req, res) => {
  res.send('Servidor de revisión de código con IA corriendo.');
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
