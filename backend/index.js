const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

async function getChangedFiles(owner, repo, prNumber, headers) {
  const response = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`,
    { headers }
  );
  return response.data;
}

function buildPrompt(filename, patch) {
  return `
Actúa como un desarrollador senior. Revisa el siguiente fragmento de código en el archivo ${filename}.
Sugiere mejoras sobre buenas prácticas, legibilidad y escalabilidad. Agrega TODOs si es necesario:

${patch}
`;
}

async function getReviewFromOpenAI(prompt) {
  const response = await axios.post(
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
  return response.data.choices[0].message.content;
}

async function postReviewComment(owner, repo, prNumber, filename, comment, headers) {
  await axios.post(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    { body: `💡 Revisión del archivo **${filename}**:\n\n${comment}` },
    { headers }
  );
}

// Helper functions
function buildMcpPrompt({ project_name, repo_url, current_task, user_notes, last_model_action, file, content }) {
  return `
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
}

async function fetchGithubFileContent(repo_url, file, headers) {
  const path = file.replace(/^\/+/, '');
  const [owner, repo] = repo_url.split('/').slice(-2);
  const fileResponse = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    { headers }
  );
  return Buffer.from(fileResponse.data.content, 'base64').toString('utf8');
}

async function getOpenAiSuggestions(prompt, headers) {
  const response = await axios.post(
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
      }
    }
  );
  return response.data.choices[0].message.content;
}

async function createAutoPR(repo_url, context_files, results) {
  const simpleGit = require('simple-git');
  const { execSync } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const tmp = require('os').tmpdir();
  const timestamp = Date.now();
  const branchName = `mcp-review-${timestamp}`;
  const [owner, repo] = repo_url.split('/').slice(-2);
  const localPath = path.join(tmp, `${repo}-${timestamp}`);

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
    {
      headers: {
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
      }
    }
  );

  console.log('PR creado con éxito:', prResponse.data.html_url);
}

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
      const archivos = await getChangedFiles(owner, repo, prNumber, headers);

      for (const archivo of archivos) {
        const nombreArchivo = archivo.filename;
        const patch = archivo.patch;

        if (!patch) continue;

        const prompt = buildPrompt(nombreArchivo, patch);
        const comentarios = await getReviewFromOpenAI(prompt);
        await postReviewComment(owner, repo, prNumber, nombreArchivo, comentarios, headers);
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
        const content = await fetchGithubFileContent(repo_url, file, headers);
        const prompt = buildMcpPrompt({
          project_name,
          repo_url,
          current_task,
          user_notes,
          last_model_action,
          file,
          content
        });
        prompts.push(prompt);
      } catch (err) {
        console.warn(`No se pudo obtener el archivo ${file}:`, err.message);
      }
    }

    const results = [];
    for (const prompt of prompts) {
      const suggestion = await getOpenAiSuggestions(prompt);
      results.push(suggestion);
    }

    res.json({ results });

    if (req.body.create_pr) {
      setTimeout(async () => {
        await createAutoPR(repo_url, context_files, results);
      }, 0);
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
