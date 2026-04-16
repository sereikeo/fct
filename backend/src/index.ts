import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { cashflowRouter } from './routes/cashflow';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api/cashflow', cashflowRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'FCT Backend is running' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});