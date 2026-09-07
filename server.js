import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { config } from './lib/config.js';
import sessionsRouter from './routes/sessions.js';
import messagesRouter from './routes/messages.js';
import settingsRouter from './routes/settings.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// 路由
app.use('/api/sessions', sessionsRouter);
app.use('/api/sessions', messagesRouter);
app.use('/api/sessions', settingsRouter);

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
});

// 统一错误处理
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

app.listen(config.port, () => {
  console.log(`Bunny's Home 后端已启动：http://localhost:${config.port}`);
});
