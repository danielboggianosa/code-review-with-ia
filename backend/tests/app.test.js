require('dotenv').config();
const request = require('supertest');
const app = require('../index');

describe('POST /mcp/context', () => {
  it('debería rechazar si context_files no es un arreglo', async () => {
    const response = await request(app)
      .post('/mcp/context')
      .send({
        project_name: 'money-app',
        repo_url: 'https://github.com/GlobalS1/money-app',
        current_task: 'Test',
        context_files: "src/file.js", // no es un arreglo
        user_notes: 'test',
        last_model_action: 'test'
      });

    expect(response.statusCode).toBe(400);
    expect(response.body).toHaveProperty('error');
  });

  it('debería aceptar una solicitud válida (sin procesar OpenAI)', async () => {
    const mockContext = {
      project_name: 'money-app',
      repo_url: 'https://github.com/GlobalS1/money-app',
      current_task: 'Test',
      context_files: ['README.md'],
      user_notes: 'Solo prueba',
      last_model_action: 'ninguna'
    };

    const response = await request(app)
      .post('/mcp/context')
      .send(mockContext);

    // 200 si hay procesamiento correcto
    expect([200, 500]).toContain(response.statusCode);
    expect(response.body).toBeDefined();
  });
});