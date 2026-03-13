import express from 'express';
import { createServer as createViteServer } from 'vite';
import yahooFinance from 'yahoo-finance2';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(cors());

// Simple JSON Database for persistence
const DB_FILE = 'database.json';
function readDB() {
  if (!fs.existsSync(DB_FILE)) return { users: {}, portfolios: {} };
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}
function writeDB(data: any) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// --- Google OAuth ---
app.get('/api/auth/url', (req, res) => {
  const { redirectUri } = req.query;
  if (!redirectUri) return res.status(400).json({ error: 'redirectUri is required' });
  
  // Pass redirectUri in the state parameter to use it in the callback
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri as string)}&response_type=code&scope=email%20profile&state=${encodeURIComponent(redirectUri as string)}`;
  res.json({ url: authUrl });
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  const redirectUri = state as string;

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        code: code as string,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      })
    });
    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      throw new Error('Failed to get access token');
    }

    const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userData = await userResponse.json();

    // Save user
    const db = readDB();
    db.users[userData.id] = { id: userData.id, email: userData.email, name: userData.name, picture: userData.picture };
    writeDB(db);

    // Generate JWT
    const token = jwt.sign(
      { id: userData.id, email: userData.email, name: userData.name, picture: userData.picture }, 
      process.env.JWT_SECRET || 'fallback_secret', 
      { expiresIn: '7d' }
    );

    res.send(`
      <html>
        <body>
          <script>
            const token = '${token}';
            const user = ${JSON.stringify(userData)};
            
            if (window.opener && !window.opener.closed) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', token, user }, '*');
              window.close();
            }
            
            // Fallback for mobile browsers where window.opener is lost
            localStorage.setItem('quant_token', token);
            localStorage.setItem('quant_user', JSON.stringify(user));
            
            setTimeout(() => {
              document.body.innerHTML = '<div style="font-family: sans-serif; padding: 40px 20px; text-align: center; color: #10b981; background: #09090b; height: 100vh; margin: 0;"><h2 style="margin-bottom: 10px;">登录成功！</h2><p style="color: #a1a1aa;">请手动关闭此页面并返回应用。</p></div>';
            }, 500);
          </script>
          <div style="font-family: sans-serif; padding: 40px 20px; text-align: center; color: #10b981; background: #09090b; height: 100vh; margin: 0;">
            <p>Authentication successful. Processing...</p>
          </div>
        </body>
      </html>
    `);
  } catch (error: any) {
    console.error('OAuth Error:', error);
    res.status(500).send(`Authentication failed: ${error.message}`);
  }
});

// --- API Endpoints ---
const authenticate = (req: any, res: any, next: any) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

app.get('/api/sync', authenticate, (req: any, res: any) => {
  const db = readDB();
  const data = db.portfolios[req.user.id] || { transactions: [] };
  res.json(data);
});

app.post('/api/sync', authenticate, (req: any, res: any) => {
  const db = readDB();
  db.portfolios[req.user.id] = req.body;
  writeDB(db);
  res.json({ success: true });
});

app.get('/api/quote', async (req, res) => {
  const { symbol, symbols } = req.query;
  
  if (!symbol && !symbols) return res.status(400).json({ error: 'Symbol(s) is required' });
  
  try {
    const symbolList = symbols ? symbols.toString().split(',') : [symbol!.toString()];
    const queryToSymbolMap: Record<string, string> = {};
    
    const querySymbols = symbolList.map(sym => {
      let querySymbol = sym.toLowerCase().trim();
      if (!/^(sh|sz|hk|us|bj)[a-z0-9]+$/.test(querySymbol)) {
        if (/^\d{6}$/.test(querySymbol)) {
          if (querySymbol.startsWith('6')) querySymbol = 'sh' + querySymbol;
          else if (querySymbol.startsWith('0') || querySymbol.startsWith('3')) querySymbol = 'sz' + querySymbol;
          else if (querySymbol.startsWith('4') || querySymbol.startsWith('8')) querySymbol = 'bj' + querySymbol;
        } else if (/^\d{4,5}$/.test(querySymbol)) {
          querySymbol = 'hk' + querySymbol.padStart(5, '0');
        } else if (/^[a-z]+$/.test(querySymbol)) {
          querySymbol = 'us' + querySymbol.toUpperCase();
        }
      }
      queryToSymbolMap[querySymbol.toLowerCase()] = sym;
      return querySymbol;
    });

    const response = await fetch(`https://qt.gtimg.cn/q=${querySymbols.join(',')}&_=${Date.now()}`);
    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder('gbk');
    const text = decoder.decode(buffer);

    if (!text) {
      throw new Error('Empty response from API');
    }

    const results: Record<string, { price: number, name: string, change: number }> = {};
    
    const lines = text.split(';');
    lines.forEach(line => {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.includes('v_pv_none_match')) return;
      
      const match = trimmedLine.match(/^v_([a-zA-Z0-9]+)=/);
      if (!match) return;
      
      const querySymbol = match[1].toLowerCase();
      const originalSymbol = queryToSymbolMap[querySymbol];
      
      if (!originalSymbol) return;

      const parts = line.split('~');
      if (parts.length >= 33) {
        const price = parseFloat(parts[3]);
        if (!isNaN(price)) {
          results[originalSymbol] = {
            price: price,
            name: parts[1],
            change: parseFloat(parts[32]) || 0
          };
        }
      }
    });

    // If single symbol was requested, maintain backward compatibility
    if (symbol && !symbols) {
      const result = results[symbol.toString()];
      if (result) {
        return res.json({ symbol: symbol, ...result });
      } else {
        return res.status(404).json({ error: 'Stock not found' });
      }
    }

    // Return map for multiple symbols
    res.json(results);
  } catch (error: any) {
    console.error(`Quote error:`, error.message);
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
});

app.get('/api/kline', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Symbol is required' });
  
  try {
    let querySymbol = symbol.toString().toLowerCase().trim();
    if (!/^(sh|sz|hk|us|bj)[a-z0-9]+$/.test(querySymbol)) {
      if (/^\d{6}$/.test(querySymbol)) {
        if (querySymbol.startsWith('6')) querySymbol = 'sh' + querySymbol;
        else if (querySymbol.startsWith('0') || querySymbol.startsWith('3')) querySymbol = 'sz' + querySymbol;
        else if (querySymbol.startsWith('4') || querySymbol.startsWith('8')) querySymbol = 'bj' + querySymbol;
      } else if (/^\d{4,5}$/.test(querySymbol)) {
        querySymbol = 'hk' + querySymbol.padStart(5, '0');
      } else if (/^[a-z]+$/.test(querySymbol)) {
        querySymbol = 'us' + querySymbol.toUpperCase();
      }
    }

    const response = await fetch(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${querySymbol},day,,,50,qfq`);
    const data = await response.json();
    res.json(data);
  } catch (error: any) {
    console.error(`Kline error:`, error.message);
    res.status(500).json({ error: 'Failed to fetch kline data' });
  }
});

// --- Vite Middleware ---
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
    // SPA fallback
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
