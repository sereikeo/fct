export function authenticate(req: any, res: any, next: any) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  if (token !== process.env.API_TOKEN) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  next();
}