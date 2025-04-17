const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config();

const environments = {
  PORT: process.env.PORT || 3000,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4.1',
};

class GithubRepository {
  async getChangedFiles(owner, repo, prNumber, headers) {
    const response = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`,
      { headers }
    );
    return response.data;
  }

  async fetchGithubFileContent({ repo_url, file, headers, baseBranch }) {
    const path = file.replace(/^\/+/, '');
    const [owner, repo] = repo_url.split('/').slice(-2);
    const fileResponse = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers }
    );
    return Buffer.from(fileResponse.data.content, 'base64').toString('utf8');
  }

  async listGithubFilesRecursive(owner, repo, path = '', accumulator = [], filterExts = []) {
    const githubToken = environments.GITHUB_TOKEN;
    const headers = {
      Authorization: `token ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
    };

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const response = await axios.get(url, { headers });

    for (const item of response.data) {
      if (item.type === 'file') {
        if (filterExts.length === 0 || filterExts.some(ext => item.path.endsWith(ext))) {
          accumulator.push(item.path);
        }
      } else if (item.type === 'dir') {
        await this.listGithubFilesRecursive(owner, repo, item.path, accumulator, filterExts);
      }
    }

    return accumulator;
  }

  async createAutoPR({ repo_url, context_files, results, baseBranch }) {
    try {

      const simpleGit = require('simple-git');
      const { execSync } = require('child_process');
      const fs = require('fs');
      const path = require('path');
      const tmp = require('os').tmpdir();
      const timestamp = Date.now();
      const branchName = `code-review-${timestamp}`;
      const [owner, repo] = repo_url.split('/').slice(-2);
      const localPath = path.join(tmp, `${repo}-${timestamp}`);

      execSync(`git clone https://github.com/${owner}/${repo}.git ${localPath}`);
      const git = simpleGit(localPath);

      await git.checkoutLocalBranch(branchName);

      for (let i = 0; i < context_files.length; i++) {
        const filePath = path.join(localPath, context_files[i]);
        if (!fs.existsSync(filePath)) continue;

        const updated = results[i][0]
          .replace('```javascript\n', '')
          .replace('```js\n', '')
          .replace('```\n\n', '');

        fs.writeFileSync(filePath, updated, 'utf8');
      }

      await git.add('.');
      await git.commit('chore: agregar cambios sugeridos');
      await git.push('origin', branchName);

      const prResponse = await axios.post(
        `https://api.github.com/repos/${owner}/${repo}/pulls`,
        {
          title: `Revisión - ${new Date().toISOString()}`,
          head: branchName,
          base: baseBranch,
          body: results.map((r, i) => `### ${context_files[i]}\n\n${r[1] ?? ''}`).join('\n\n---\n\n')
        },
        {
          headers: {
            Authorization: `token ${environments.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
          }
        }
      );

      console.log('PR creado con éxito:', prResponse.data.html_url);
    } catch (error) {
      console.error('Error al crear PR:', error.message);
    }
  }

  async postReviewComment(owner, repo, prNumber, filename, comment, headers) {
    await axios.post(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      { body: `💡 Revisión del archivo **${filename}**:\n\n${comment}` },
      { headers }
    );
  }
}

class OpenAiService {
  async getReviewFromOpenAI(prompt) {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: environments.OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 1,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${environments.OPENAI_API_KEY}`,
        },
      }
    );
    return response.data.choices[0].message.content;
  }

  async getOpenAiSuggestions(prompt) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: prompt }],
          temperature: 1,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${environments.OPENAI_API_KEY}`,
          }
        }
      );
      return response.data.choices[0].message.content;
    } catch (error) {
      console.log('Error al obtener sugerencias', { error: error.response.data });
    }
  }
}

class Controller {
  constructor({ repositories, services }) {
    this.codeRepository = repositories.codeRepository;
    this.aiService = services.aiService;
  }

  async createCodeReview(req, res) {
    const {
      project_name,
      repo_url,
      context_files,
      create_pr,
      baseBranch = 'main',
    } = req.body;

    if (!context_files || !Array.isArray(context_files)) {
      return res.status(400).json({ error: 'context_files debe ser un arreglo con nombres de archivos' });
    }

    try {
      const githubToken = environments.GITHUB_TOKEN;
      const headers = {
        Authorization: `token ${githubToken}`,
        Accept: 'application/vnd.github.v3+json',
      };

      const prompts = [];

      for (const file of context_files) {
        try {
          const content = await this.codeRepository.fetchGithubFileContent({ repo_url, file, headers, baseBranch });
          let prompt = "";

          if (content)
            prompt = this.buildMcpPrompt({
              project_name,
              repo_url,
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
        let suggestion = ""
        if (prompt) suggestion = await this.aiService.getOpenAiSuggestions(prompt);
        results.push(suggestion?.split('########'));
      }

      res.json({ results });

      if (create_pr) {
        setTimeout(async () => {
          await this.codeRepository.createAutoPR({ repo_url, context_files, results, baseBranch });
        }, 0);
      }
    } catch (error) {
      console.error('Error al procesar MCP:', error.message);
      res.status(500).json({ error: 'Error interno al procesar contexto' });
    }
  }

  async listRepositoryFiles(req, res) {
    const { repo_url } = req.query; // extensions es opcional

    if (!repo_url) {
      return res.status(400).json({ error: 'Se requiere repo_url' });
    }

    const [owner, repo] = repo_url.split('/').slice(-2);

    try {
      const files = await this.codeRepository.listGithubFilesRecursive(owner, repo, '', [], []);
      res.json({ files });
    } catch (error) {
      console.error('Error al listar archivos del repositorio:', error.message);
      res.status(500).json({ error: 'No se pudieron listar los archivos del repositorio' });
    }
  }

  async processPRSent(req, res) {
    const event = req.headers['x-github-event'];
    const payload = req.body;

    if (event === 'pull_request' && (payload.action === 'opened' || payload.action === 'synchronize')) {
      const prNumber = payload.pull_request.number;
      const repo = payload.repository.name;
      const owner = payload.repository.owner.login;

      console.log(`Revisión de PR #${prNumber} en ${owner}/${repo}`);

      const githubToken = environments.GITHUB_TOKEN;
      const headers = {
        Authorization: `token ${githubToken}`,
        Accept: 'application/vnd.github.v3+json',
      };

      try {
        const archivos = await this.codeRepository.getChangedFiles(owner, repo, prNumber, headers);

        for (const archivo of archivos) {
          const nombreArchivo = archivo.filename;
          const patch = archivo.patch;

          if (!patch) continue;

          const prompt = this.buildPrompt(nombreArchivo, patch);
          const comentarios = await this.aiService.getReviewFromOpenAI(prompt);
          await this.codeRepository.postReviewComment(owner, repo, prNumber, nombreArchivo, comentarios, headers);
        }
      } catch (error) {
        console.error('Error al procesar revisión con IA:', error.message);
      }

      return res.status(200).send({ message: 'PR recibido. Revisión en proceso...' });
    }

    res.status(200).send({ message: 'Evento recibido, no relevante para revisión.' });
  }

  buildPrompt(filename, patch) {
    return `
Actúa como un desarrollador senior. Revisa el siguiente fragmento de código en el archivo ${filename}.
Sugiere mejoras sobre buenas prácticas, legibilidad y escalabilidad. Agrega TODOs si es necesario:

${patch}
`;
  }

  buildMcpPrompt({ project_name, repo_url, file, content, language = 'español' }) {
    return `
Proyecto: ${project_name}
Repositorio: ${repo_url}
Archivo: ${file}

Contenido del archivo:
${content}

👉 Actúa como un desarrollador senior y revisa el contenido del archivo y sugiere mejoras sobre buenas prácticas, legibilidad y escalabilidad basados en los lineamientos de SonarQube. Agrega comentarios con TODOs encima de cada línea si consideras necesario. Se lo más conciso posible para reducir la cantidad de tokens al maximo. Todo el texto agregado debe ir con signos comentarios de la siguiente forma: (/* [TODOS o sugerencias en múltiples líneas] */). Usa ${language} para hacer los comentarios. Debes devolver 2 elementos, el primero debe ser el código con los comentarios, es segundo un resumen o sugerencias adicionales, debes separarlo por ########
  `;
  }
}

const app = express();
const router = express.Router();

app.use(bodyParser.json());
app.use(cors());
app.use(morgan('dev'));

const AppContext = {
  repositories: {
    codeRepository: new GithubRepository(),
  },
  services: {
    aiService: new OpenAiService(),
  },
};

const controller = new Controller(AppContext);

router.post('/webhook', (req, res) => controller.processPRSent(req, res));
router.post('/repositories/code-review', (req, res) => controller.createCodeReview(req, res));
router.get('/repositories/files', (req, res) => controller.listRepositoryFiles(req, res));

// Ruta base
app.get('/health', (req, res) => {
  res.send('Servidor de revisión de código con IA corriendo.');
});

app.use('/api/v1', router);

app.listen(environments.PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${environments.PORT}`);
});
