import express from 'express';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const app = express();
const port = Number(process.env.PORT ?? 8080);
const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(serverDirectory, '../../dist');

app.disable('x-powered-by');
app.use(express.json({limit: '1mb'}));

app.get('/api/health', (_request, response) => {
  response.json({
    service: 'doorman',
    status: 'scaffolded',
  });
});

app.use(express.static(webDirectory));
app.get('*', (_request, response) => {
  response.sendFile(path.join(webDirectory, 'index.html'));
});

app.listen(port, () => {
  console.log(`Doorman listening on port ${port}`);
});

