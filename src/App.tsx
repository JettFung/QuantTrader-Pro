/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo, useEffect, useRef } from 'react';
import { GoogleGenAI } from '@google/genai';
import ReactMarkdown from 'react-markdown';
import { motion } from 'motion/react';
import { 
  LineChart as LineChartIcon, 
  TrendingUp, 
  Briefcase, 
  Activity, 
  AlertCircle, 
  Loader2,
  Terminal,
  Plus,
  Trash2,
  RefreshCw,
  ArrowRightLeft,
  Globe,
  LogOut,
  X,
  Download,
  Upload
} from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

// Initialize Gemini API
const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });

// --- Types ---
type TransactionType = 'BUY' | 'SELL';

interface Transaction {
  id: string;
  symbol: string;
  name: string;
  type: TransactionType;
  price: number;
  shares: number;
  date: string;
}

interface Holding {
  symbol: string;
  name: string;
  shares: number;
  averageCost: number;
  currentPrice: number;
}

interface User {
  id: string;
  email: string;
  name: string;
  picture?: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'portfolio' | 'analysis'>('portfolio');

  // --- Auth State ---
  const [user, setUser] = useState<User | null>(() => {
    const saved = localStorage.getItem('quant_user');
    return saved ? JSON.parse(saved) : null;
  });
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('quant_token'));

  // --- Portfolio State ---
  const [transactions, setTransactions] = useState<Transaction[]>(() => {
    const saved = localStorage.getItem('quant_transactions');
    return saved ? JSON.parse(saved) : [];
  });
  
  const [currentPrices, setCurrentPrices] = useState<Record<string, number>>({});
  const [isSyncing, setIsSyncing] = useState(false);
  const isInitialLoad = useRef(true);

  const [txForm, setTxForm] = useState({
    type: 'BUY' as TransactionType,
    symbol: '',
    name: '',
    price: '',
    shares: '',
    date: new Date().toISOString().split('T')[0]
  });
  const [isFetchingSymbol, setIsFetchingSymbol] = useState(false);

  const handleSymbolBlur = async () => {
    if (!txForm.symbol) return;
    setIsFetchingSymbol(true);
    try {
      const res = await fetch(`/api/quote?symbol=${txForm.symbol}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.name) {
          setTxForm(prev => ({
            ...prev,
            name: data.name,
            price: prev.price || data.price?.toString() || ''
          }));
        }
      }
    } catch (error) {
      console.error('Failed to fetch stock info:', error);
    } finally {
      setIsFetchingSymbol(false);
    }
  };

  const [authUrl, setAuthUrl] = useState<string>('');

  // --- Chart Modal State ---
  const [selectedStock, setSelectedStock] = useState<Holding | null>(null);
  const [klineData, setKlineData] = useState<any[]>([]);
  const [klineLoading, setKlineLoading] = useState(false);

  useEffect(() => {
    if (!selectedStock) return;
    
    const fetchKline = async () => {
      setKlineLoading(true);
      try {
        const res = await fetch(`/api/kline?symbol=${selectedStock.symbol}`);
        const json = await res.json();
        
        let dataPoints = [];
        if (json.data) {
          // The key might be the symbol itself, e.g., json.data.sh600519
          const keys = Object.keys(json.data);
          if (keys.length > 0) {
            const stockData = json.data[keys[0]];
            // Usually 'qfqday' or 'day' is the array of kline data
            const klineArray = stockData.qfqday || stockData.day || [];
            
            // Format: [date, open, close, high, low, volume]
            dataPoints = klineArray.map((item: any) => ({
              date: item[0],
              open: parseFloat(item[1]),
              close: parseFloat(item[2]),
              high: parseFloat(item[3]),
              low: parseFloat(item[4]),
              volume: parseFloat(item[5])
            }));
          }
        }
        setKlineData(dataPoints);
      } catch (err) {
        console.error('Failed to fetch kline data:', err);
        setKlineData([]);
      } finally {
        setKlineLoading(false);
      }
    };

    fetchKline();
  }, [selectedStock]);

  // --- Auth Actions ---
  useEffect(() => {
    // Pre-fetch auth URL to allow synchronous window.open or direct link click
    const fetchAuthUrl = async () => {
      try {
        const redirectUri = `${window.location.origin}/auth/callback`;
        const res = await fetch(`/api/auth/url?redirectUri=${encodeURIComponent(redirectUri)}`);
        const data = await res.json();
        if (data.url) {
          setAuthUrl(data.url);
        }
      } catch (err) {
        console.error('Failed to pre-fetch auth URL', err);
      }
    };
    fetchAuthUrl();
  }, []);

  const handleLogout = () => {
    setUser(null);
    setToken(null);
    setTransactions([]);
    localStorage.removeItem('quant_user');
    localStorage.removeItem('quant_token');
    localStorage.removeItem('quant_transactions');
  };

  // Listen for OAuth success
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Allow localhost or run.app origins
      if (!event.origin.includes('localhost') && !event.origin.endsWith('.run.app')) return;
      
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        setUser(event.data.user);
        setToken(event.data.token);
        localStorage.setItem('quant_user', JSON.stringify(event.data.user));
        localStorage.setItem('quant_token', event.data.token);
      }
    };
    window.addEventListener('message', handleMessage);

    // Also listen for localStorage changes (for mobile fallback where popup sets localStorage)
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'quant_token') {
        if (e.newValue) {
          setToken(e.newValue);
          const userStr = localStorage.getItem('quant_user');
          if (userStr) {
            try {
              setUser(JSON.parse(userStr));
            } catch (err) {}
          }
        } else {
          // Handle logout from another tab
          setToken(null);
          setUser(null);
          setTransactions([]);
        }
      }
    };
    window.addEventListener('storage', handleStorage);

    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  // --- Sync Logic ---
  const isFetchingSync = useRef(false);

  // Load data on login
  useEffect(() => {
    if (token) {
      setIsSyncing(true);
      isFetchingSync.current = true;
      fetch('/api/sync', {
        headers: { Authorization: `Bearer ${token}` }
      })
      .then(res => res.json())
      .then(data => {
        if (data.transactions) {
          setTransactions(data.transactions);
          localStorage.setItem('quant_transactions', JSON.stringify(data.transactions));
        }
      })
      .catch(err => console.error('Sync load error:', err))
      .finally(() => {
        setIsSyncing(false);
        // Allow a small delay before enabling saves to prevent race conditions
        setTimeout(() => {
          isFetchingSync.current = false;
        }, 500);
      });
    }
  }, [token]);

  // Save data on change
  useEffect(() => {
    if (isInitialLoad.current) {
      isInitialLoad.current = false;
      return;
    }
    
    localStorage.setItem('quant_transactions', JSON.stringify(transactions));
    
    if (token && !isFetchingSync.current) {
      setIsSyncing(true);
      fetch('/api/sync', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}` 
        },
        body: JSON.stringify({ transactions })
      })
      .catch(err => console.error('Sync save error:', err))
      .finally(() => setIsSyncing(false));
    }
  }, [transactions]); // removed token from dependencies

  // --- Real Stock API Polling ---
  useEffect(() => {
    const fetchQuotes = async () => {
      const symbols = Array.from(new Set(transactions.map(tx => tx.symbol)));
      if (symbols.length === 0) return;

      try {
        // Split into chunks of 40 to avoid URL length limits
        const chunkSize = 40;
        const newPrices: Record<string, number> = {};

        for (let i = 0; i < symbols.length; i += chunkSize) {
          const chunk = symbols.slice(i, i + chunkSize);
          const res = await fetch(`/api/quote?symbols=${encodeURIComponent(chunk.join(','))}`);
          
          if (res.ok) {
            const data = await res.json();
            // data is a map: { "AAPL": { price: 150, ... }, "sh600519": { price: 1400, ... } }
            for (const [sym, info] of Object.entries(data)) {
              if (info && typeof (info as any).price === 'number') {
                newPrices[sym] = (info as any).price;
              }
            }
          }
        }

        if (Object.keys(newPrices).length > 0) {
          setCurrentPrices(prev => ({ ...prev, ...newPrices }));
        }
      } catch (err) {
        console.error(`Failed to fetch quotes`, err);
      }
    };

    // Fetch immediately, then every 5 seconds for real-time feel
    fetchQuotes();
    const interval = setInterval(fetchQuotes, 5000);
    return () => clearInterval(interval);
  }, [transactions]); // Re-run if transactions change to pick up new symbols

  // Calculate Holdings (Smart Merge)
  const holdings = useMemo(() => {
    const map: Record<string, Holding> = {};
    const sortedTxs = [...transactions].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    sortedTxs.forEach(tx => {
      if (!map[tx.symbol]) {
        map[tx.symbol] = {
          symbol: tx.symbol,
          name: tx.name,
          shares: 0,
          averageCost: 0,
          currentPrice: currentPrices[tx.symbol] || tx.price
        };
      }
      
      const h = map[tx.symbol];
      h.currentPrice = currentPrices[tx.symbol] || tx.price;

      if (tx.type === 'BUY') {
        const totalCost = h.shares * h.averageCost + tx.shares * tx.price;
        h.shares += tx.shares;
        h.averageCost = totalCost / h.shares;
      } else if (tx.type === 'SELL') {
        h.shares -= tx.shares;
        if (h.shares <= 0) {
          h.shares = 0;
          h.averageCost = 0;
        }
      }
    });

    return Object.values(map).filter(h => h.shares > 0);
  }, [transactions, currentPrices]);

  // Portfolio Actions
  const handleQuickTrade = (h: Holding, type: TransactionType) => {
    setTxForm({
      type,
      symbol: h.symbol,
      name: h.name,
      price: h.currentPrice.toString(),
      shares: '',
      date: new Date().toISOString().split('T')[0]
    });
    // Scroll to form
    document.getElementById('trade-form')?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleAddTransaction = (e: React.FormEvent) => {
    e.preventDefault();
    if (!txForm.symbol || !txForm.name || !txForm.price || !txForm.shares) return;

    const newTx: Transaction = {
      id: crypto.randomUUID(),
      symbol: txForm.symbol.toUpperCase(),
      name: txForm.name,
      type: txForm.type,
      price: parseFloat(txForm.price),
      shares: parseInt(txForm.shares, 10),
      date: txForm.date
    };

    setTransactions(prev => [newTx, ...prev]);
    
    if (!currentPrices[newTx.symbol]) {
      setCurrentPrices(prev => ({ ...prev, [newTx.symbol]: newTx.price }));
    }

    setTxForm(prev => ({ ...prev, symbol: '', name: '', price: '', shares: '' }));
  };

  const handleDeleteTransaction = (id: string) => {
    setTransactions(prev => prev.filter(tx => tx.id !== id));
  };

  const handleExport = () => {
    const dataStr = JSON.stringify(transactions, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `quant_trader_backup_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const importedData = JSON.parse(event.target?.result as string);
        if (Array.isArray(importedData)) {
          // Basic validation
          const isValid = importedData.every(tx => tx.id && tx.type && tx.symbol && tx.price && tx.shares && tx.date);
          if (isValid) {
            setTransactions(importedData);
            alert('数据导入成功！');
          } else {
            alert('数据格式不正确，请确保导入的是有效的备份文件。');
          }
        } else {
          alert('数据格式不正确。');
        }
      } catch (err) {
        alert('读取文件失败，请确保文件是有效的 JSON 格式。');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // --- Analysis State ---
  const [marketData, setMarketData] = useState('');
  const [stockInfo, setStockInfo] = useState('');
  const [holdingsInput, setHoldingsInput] = useState('');
  const [useNetwork, setUseNetwork] = useState(true);
  
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const syncHoldingsToAnalysis = () => {
    if (holdings.length === 0) {
      setHoldingsInput('当前无持仓。');
      return;
    }
    const text = holdings.map(h => {
      const pl = h.currentPrice - h.averageCost;
      const plPercent = (pl / h.averageCost) * 100;
      return `${h.name}(${h.symbol}): ${h.shares}股, 成本价 ¥${h.averageCost.toFixed(3)}, 现价 ¥${h.currentPrice.toFixed(3)}, 浮动盈亏 ${plPercent > 0 ? '+' : ''}${plPercent.toFixed(3)}%`;
    }).join('\n');
    setHoldingsInput(text);
  };

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!marketData.trim() && !stockInfo.trim() && !holdingsInput.trim()) {
      setError('请输入至少一项数据以进行分析。');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const prompt = `
你是一位顶级的量化金融分析师和资深股票操盘手。你的任务是根据用户提供的实时大盘数据、个股信息以及用户的个人持股仓位，提供客观、理性的投资建议。

${useNetwork ? '【重要指令】：你已开启联网搜索功能。请务必使用工具搜索最新的实时大盘指数、相关个股的最新价格、突发新闻及财报数据，以补充和验证用户提供的信息。' : ''}

用户提供的数据如下：
【实时大盘数据】：${marketData || '未提供'}
【个股信息】：${stockInfo || '未提供'}
【个人持股仓位】：\n${holdingsInput || '未提供'}

你的回答必须包含以下结构：
1. 大盘及个股现状分析：基于提供的数据${useNetwork ? '及你搜索到的最新实时网络数据' : ''}进行简短的趋势解读。
2. 持股操作建议：针对用户的当前持股（明确指出是继续持有、加仓、减仓还是清仓），并给出逻辑支撑。
3. 个股推荐：根据当前市场热点或数据，推荐 1-2 只具有潜力的标的，并说明风险。

注意：请保持专业、冷静的语气。必须在结尾声明‘本建议仅供参考，不构成绝对投资指导’。
      `;

      const config: any = {
        temperature: 0.2,
      };

      // Enable Google Search Grounding if toggle is on
      if (useNetwork) {
        config.tools = [{ googleSearch: {} }];
      }

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config
      });

      if (response.text) {
        setResult(response.text);
      } else {
        throw new Error('未能生成分析结果，请重试。');
      }
    } catch (err: any) {
      console.error('Analysis error:', err);
      
      // 将具体的错误信息转换为字符串以便进行匹配
      const errorMessage = err.message || JSON.stringify(err);

      // 拦截 API Key 无效的错误
      if (errorMessage.includes('API key not valid') || errorMessage.includes('API_KEY_INVALID')) {
        setError('未配置有效的 API 密钥，AI 智能分析功能暂未开启。');
      } 
      // 拦截配额超限错误 (429)
      else if (errorMessage.includes('quota') || errorMessage.includes('429')) {
        setError('当前 AI 访问请求过多，请稍等片刻后再试。');
      } 
      // 默认的兜底错误提示
      else {
        setError('分析过程中发生未知错误，请稍后重试。');
      }
    } finally {
      setLoading(false);
    }
  };

  // --- Helpers ---
  const formatMoney = (val: number) => `¥${val.toFixed(2)}`;
  const formatPercent = (val: number) => `${val > 0 ? '+' : ''}${val.toFixed(2)}%`;

  const totalMarketValue = holdings.reduce((sum, h) => sum + h.shares * h.currentPrice, 0);
  const totalCost = holdings.reduce((sum, h) => sum + h.shares * h.averageCost, 0);
  const totalPL = totalMarketValue - totalCost;
  const totalPLPercent = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300 font-sans selection:bg-emerald-500/30 pb-20 md:pb-8">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20 shrink-0">
              <Terminal className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-500" />
            </div>
            <h1 className="text-base sm:text-lg font-semibold text-zinc-100 tracking-tight truncate">QuantTrader Pro</h1>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="hidden sm:flex items-center gap-1.5 text-xs font-mono text-zinc-500">
              <span className={`w-2 h-2 rounded-full ${isSyncing ? 'bg-blue-500 animate-pulse' : 'bg-emerald-500'}`}></span>
              {isSyncing ? 'SYNCING...' : 'REAL-TIME API'}
            </div>
            
            {/* Auth Button */}
            {user ? (
              <div className="flex items-center gap-3">
                <div className="hidden sm:flex items-center gap-2 text-sm text-zinc-400">
                  {user.picture && <img src={user.picture} alt="Avatar" className="w-6 h-6 rounded-full" referrerPolicy="no-referrer" />}
                  <span>{user.name}</span>
                </div>
                <button 
                  onClick={handleLogout}
                  className="p-2 text-zinc-400 hover:text-zinc-200 transition-colors bg-zinc-900 rounded-lg border border-zinc-800"
                  title="退出登录"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <a 
                href={authUrl || '#'}
                target="oauth_popup"
                onClick={(e) => {
                  if (!authUrl) {
                    e.preventDefault();
                    alert('正在获取登录链接，请稍后再试...');
                  }
                }}
                className="px-3 py-1.5 text-sm font-medium text-zinc-900 bg-zinc-100 hover:bg-white rounded-lg transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24">
                  <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                  <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                </svg>
                <span className="hidden sm:inline">Google 登录同步</span>
                <span className="sm:hidden">登录</span>
              </a>
            )}
          </div>
        </div>

        {/* Mobile/Desktop Tabs */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-3">
          <nav className="flex space-x-1 bg-zinc-900/80 p-1 rounded-lg border border-zinc-800 w-full sm:w-auto sm:inline-flex">
            <button
              onClick={() => setActiveTab('portfolio')}
              className={`flex-1 sm:flex-none px-4 py-2 sm:py-1.5 rounded-md text-sm font-medium transition-colors ${
                activeTab === 'portfolio' ? 'bg-zinc-800 text-zinc-100 shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              持仓管理
            </button>
            <button
              onClick={() => {
                setActiveTab('analysis');
                if (!holdingsInput) syncHoldingsToAnalysis();
              }}
              className={`flex-1 sm:flex-none px-4 py-2 sm:py-1.5 rounded-md text-sm font-medium transition-colors ${
                activeTab === 'analysis' ? 'bg-zinc-800 text-zinc-100 shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              智能分析
            </button>
          </nav>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        
        {/* PORTFOLIO TAB */}
        {activeTab === 'portfolio' && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 sm:space-y-8">
            
            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4">
              <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4 sm:p-5 col-span-2 md:col-span-1">
                <p className="text-xs sm:text-sm text-zinc-400 mb-1">总持仓市值</p>
                <p className="text-2xl sm:text-3xl font-mono text-zinc-100">{formatMoney(totalMarketValue)}</p>
              </div>
              <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4 sm:p-5">
                <p className="text-xs sm:text-sm text-zinc-400 mb-1">总持仓成本</p>
                <p className="text-lg sm:text-3xl font-mono text-zinc-100">{formatMoney(totalCost)}</p>
              </div>
              <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4 sm:p-5">
                <p className="text-xs sm:text-sm text-zinc-400 mb-1">总浮动盈亏</p>
                <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
                  <p className={`text-lg sm:text-3xl font-mono ${totalPL >= 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
                    {formatMoney(totalPL)}
                  </p>
                  <p className={`text-xs sm:text-sm font-mono ${totalPLPercent >= 0 ? 'text-rose-500/80' : 'text-emerald-500/80'}`}>
                    {formatPercent(totalPLPercent)}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 sm:gap-8">
              {/* Left: Holdings & History */}
              <div className="lg:col-span-2 space-y-6 sm:space-y-8">
                
                {/* Active Holdings */}
                <div className="bg-zinc-900/30 border border-zinc-800 rounded-xl overflow-hidden">
                  <div className="px-4 sm:px-5 py-3 sm:py-4 border-b border-zinc-800 flex justify-between items-center bg-zinc-900/50">
                    <h3 className="text-sm sm:text-base font-medium text-zinc-100 flex items-center gap-2">
                      <Briefcase className="w-4 h-4 text-emerald-500" />
                      当前持股 (真实API)
                    </h3>
                  </div>
                  
                  {/* Desktop Table View */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-sm text-left">
                      <thead className="text-xs text-zinc-500 bg-zinc-900/80 uppercase font-mono">
                        <tr>
                          <th className="px-5 py-3">代码/名称</th>
                          <th className="px-5 py-3 text-right">持仓数量</th>
                          <th className="px-5 py-3 text-right">成本价</th>
                          <th className="px-5 py-3 text-right">当前价</th>
                          <th className="px-5 py-3 text-right">浮动盈亏</th>
                          <th className="px-5 py-3 text-center">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800/50">
                        {holdings.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="px-5 py-8 text-center text-zinc-500">暂无持仓记录</td>
                          </tr>
                        ) : (
                          holdings.map(h => {
                            const pl = (h.currentPrice - h.averageCost) * h.shares;
                            const plPercent = (h.currentPrice - h.averageCost) / h.averageCost * 100;
                            const isProfit = pl >= 0;
                            return (
                              <tr key={h.symbol} className="hover:bg-zinc-800/20 transition-colors">
                                <td 
                                  className="px-5 py-3 cursor-pointer group"
                                  onClick={() => setSelectedStock(h)}
                                >
                                  <div className="font-medium text-zinc-200 group-hover:text-emerald-400 transition-colors flex items-center gap-2">
                                    {h.name}
                                    <LineChartIcon className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                                  </div>
                                  <div className="text-xs font-mono text-zinc-500">{h.symbol}</div>
                                </td>
                                <td className="px-5 py-3 text-right font-mono">{h.shares}</td>
                                <td className="px-5 py-3 text-right font-mono">{h.averageCost.toFixed(3)}</td>
                                <td className="px-5 py-3 text-right font-mono text-zinc-200">
                                  {h.currentPrice.toFixed(3)}
                                </td>
                                <td className="px-5 py-3 text-right">
                                  <div className={`font-mono ${isProfit ? 'text-rose-500' : 'text-emerald-500'}`}>
                                    {formatMoney(pl)}
                                  </div>
                                  <div className={`text-xs font-mono ${isProfit ? 'text-rose-500/70' : 'text-emerald-500/70'}`}>
                                    {formatPercent(plPercent)}
                                  </div>
                                </td>
                                <td className="px-5 py-3">
                                  <div className="flex items-center justify-center gap-2">
                                    <button 
                                      onClick={() => handleQuickTrade(h, 'BUY')}
                                      className="px-2 py-1 text-xs rounded bg-rose-500/10 text-rose-500 hover:bg-rose-500/20 transition-colors font-medium"
                                    >
                                      买入
                                    </button>
                                    <button 
                                      onClick={() => handleQuickTrade(h, 'SELL')}
                                      className="px-2 py-1 text-xs rounded bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 transition-colors font-medium"
                                    >
                                      卖出
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile Card View */}
                  <div className="md:hidden divide-y divide-zinc-800/50">
                    {holdings.length === 0 ? (
                      <div className="px-4 py-8 text-center text-sm text-zinc-500">暂无持仓记录</div>
                    ) : (
                      holdings.map(h => {
                        const pl = (h.currentPrice - h.averageCost) * h.shares;
                        const plPercent = (h.currentPrice - h.averageCost) / h.averageCost * 100;
                        const isProfit = pl >= 0;
                        return (
                          <div key={h.symbol} className="p-4 space-y-3">
                            <div className="flex justify-between items-start">
                              <div 
                                className="cursor-pointer group"
                                onClick={() => setSelectedStock(h)}
                              >
                                <div className="font-medium text-zinc-200 group-hover:text-emerald-400 transition-colors flex items-center gap-2">
                                  {h.name}
                                  <LineChartIcon className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                                </div>
                                <div className="text-xs font-mono text-zinc-500">{h.symbol}</div>
                              </div>
                              <div className="text-right">
                                <div className={`font-mono font-medium ${isProfit ? 'text-rose-500' : 'text-emerald-500'}`}>
                                  {formatMoney(pl)}
                                </div>
                                <div className={`text-xs font-mono ${isProfit ? 'text-rose-500/70' : 'text-emerald-500/70'}`}>
                                  {formatPercent(plPercent)}
                                </div>
                              </div>
                            </div>
                            <div className="grid grid-cols-3 gap-2 text-xs bg-zinc-900/50 p-2 rounded-lg">
                              <div>
                                <div className="text-zinc-500 mb-0.5">持仓</div>
                                <div className="font-mono text-zinc-300">{h.shares}</div>
                              </div>
                              <div>
                                <div className="text-zinc-500 mb-0.5">成本</div>
                                <div className="font-mono text-zinc-300">{h.averageCost.toFixed(3)}</div>
                              </div>
                              <div>
                                <div className="text-zinc-500 mb-0.5">现价</div>
                                <div className="font-mono text-zinc-300">{h.currentPrice.toFixed(3)}</div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 pt-2 border-t border-zinc-800/50">
                              <button 
                                onClick={() => handleQuickTrade(h, 'BUY')}
                                className="flex-1 py-1.5 text-xs rounded bg-rose-500/10 text-rose-500 hover:bg-rose-500/20 transition-colors font-medium"
                              >
                                买入
                              </button>
                              <button 
                                onClick={() => handleQuickTrade(h, 'SELL')}
                                className="flex-1 py-1.5 text-xs rounded bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 transition-colors font-medium"
                              >
                                卖出
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Transaction History */}
                <div className="bg-zinc-900/30 border border-zinc-800 rounded-xl overflow-hidden">
                  <div className="px-4 sm:px-5 py-3 sm:py-4 border-b border-zinc-800 bg-zinc-900/50">
                    <h3 className="text-sm sm:text-base font-medium text-zinc-100 flex items-center gap-2">
                      <ArrowRightLeft className="w-4 h-4 text-zinc-400" />
                      操作记录
                    </h3>
                  </div>
                  
                  {/* Desktop Table View */}
                  <div className="hidden md:block overflow-x-auto max-h-[400px] custom-scrollbar">
                    <table className="w-full text-sm text-left">
                      <thead className="text-xs text-zinc-500 bg-zinc-900/80 uppercase font-mono sticky top-0">
                        <tr>
                          <th className="px-5 py-3">时间</th>
                          <th className="px-5 py-3">类型</th>
                          <th className="px-5 py-3">标的</th>
                          <th className="px-5 py-3 text-right">成交价</th>
                          <th className="px-5 py-3 text-right">数量</th>
                          <th className="px-5 py-3 text-center">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800/50">
                        {transactions.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="px-5 py-8 text-center text-zinc-500">暂无操作记录</td>
                          </tr>
                        ) : (
                          transactions.map(tx => (
                            <tr key={tx.id} className="hover:bg-zinc-800/20 transition-colors">
                              <td className="px-5 py-3 font-mono text-zinc-400">{tx.date}</td>
                              <td className="px-5 py-3">
                                <span className={`px-2 py-1 rounded text-xs font-medium ${
                                  tx.type === 'BUY' ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20' : 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'
                                }`}>
                                  {tx.type === 'BUY' ? '买入' : '卖出'}
                                </span>
                              </td>
                              <td className="px-5 py-3">
                                <span className="text-zinc-200">{tx.name}</span>
                                <span className="text-xs font-mono text-zinc-500 ml-2">{tx.symbol}</span>
                              </td>
                              <td className="px-5 py-3 text-right font-mono">{tx.price.toFixed(3)}</td>
                              <td className="px-5 py-3 text-right font-mono">{tx.shares}</td>
                              <td className="px-5 py-3 text-center">
                                <button 
                                  onClick={() => handleDeleteTransaction(tx.id)}
                                  className="text-zinc-500 hover:text-red-400 transition-colors p-2"
                                  title="删除记录"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile Card View */}
                  <div className="md:hidden divide-y divide-zinc-800/50 max-h-[400px] overflow-y-auto custom-scrollbar">
                    {transactions.length === 0 ? (
                      <div className="px-4 py-8 text-center text-sm text-zinc-500">暂无操作记录</div>
                    ) : (
                      transactions.map(tx => (
                        <div key={tx.id} className="p-4 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                              tx.type === 'BUY' ? 'bg-rose-500/10 text-rose-500' : 'bg-emerald-500/10 text-emerald-500'
                            }`}>
                              <span className="text-xs font-bold">{tx.type === 'BUY' ? '买' : '卖'}</span>
                            </div>
                            <div>
                              <div className="text-sm font-medium text-zinc-200">
                                {tx.name} <span className="text-xs font-mono text-zinc-500 ml-1">{tx.symbol}</span>
                              </div>
                              <div className="text-xs font-mono text-zinc-500 mt-0.5">
                                {tx.date} • {tx.price.toFixed(3)} × {tx.shares}
                              </div>
                            </div>
                          </div>
                          <button 
                            onClick={() => handleDeleteTransaction(tx.id)}
                            className="text-zinc-500 hover:text-red-400 p-2"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>

              </div>

              {/* Right: Add Transaction Form */}
              <div className="lg:col-span-1">
                <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4 sm:p-5 lg:sticky lg:top-32">
                  <h3 className="text-sm sm:text-base font-medium text-zinc-100 mb-4 flex items-center gap-2">
                    <Plus className="w-4 h-4 text-emerald-500" />
                    记录新交易
                  </h3>
                  <form id="trade-form" onSubmit={handleAddTransaction} className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => setTxForm(prev => ({ ...prev, type: 'BUY' }))}
                        className={`py-2.5 sm:py-2 rounded-lg text-sm font-medium border transition-colors ${
                          txForm.type === 'BUY' 
                            ? 'bg-rose-500/10 border-rose-500/50 text-rose-500' 
                            : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800'
                        }`}
                      >
                        买入 (BUY)
                      </button>
                      <button
                        type="button"
                        onClick={() => setTxForm(prev => ({ ...prev, type: 'SELL' }))}
                        className={`py-2.5 sm:py-2 rounded-lg text-sm font-medium border transition-colors ${
                          txForm.type === 'SELL' 
                            ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-500' 
                            : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800'
                        }`}
                      >
                        卖出 (SELL)
                      </button>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs text-zinc-400">股票代码 (美股/A股)</label>
                      <div className="relative">
                        <input 
                          required
                          type="text" 
                          placeholder="如: AAPL 或 600519"
                          value={txForm.symbol}
                          onChange={e => setTxForm(prev => ({ ...prev, symbol: e.target.value }))}
                          onBlur={handleSymbolBlur}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 sm:p-2.5 text-base sm:text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/50 font-mono uppercase pr-10"
                        />
                        {isFetchingSymbol && (
                          <div className="absolute right-3 top-1/2 -translate-y-1/2">
                            <Loader2 className="w-4 h-4 text-emerald-500 animate-spin" />
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs text-zinc-400">股票名称</label>
                      <input 
                        required
                        type="text" 
                        placeholder="输入代码后自动获取"
                        value={txForm.name}
                        onChange={e => setTxForm(prev => ({ ...prev, name: e.target.value }))}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 sm:p-2.5 text-base sm:text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/50"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-xs text-zinc-400">成交价格</label>
                        <input 
                          required
                          type="number" 
                          step="0.001"
                          min="0"
                          placeholder="0.000"
                          value={txForm.price}
                          onChange={e => setTxForm(prev => ({ ...prev, price: e.target.value }))}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 sm:p-2.5 text-base sm:text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/50 font-mono"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs text-zinc-400">成交数量</label>
                        <input 
                          required
                          type="number" 
                          min="1"
                          step="1"
                          placeholder="100"
                          value={txForm.shares}
                          onChange={e => setTxForm(prev => ({ ...prev, shares: e.target.value }))}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 sm:p-2.5 text-base sm:text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/50 font-mono"
                        />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs text-zinc-400">交易日期</label>
                      <input 
                        required
                        type="date" 
                        value={txForm.date}
                        onChange={e => setTxForm(prev => ({ ...prev, date: e.target.value }))}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 sm:p-2.5 text-base sm:text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/50 font-mono [color-scheme:dark]"
                      />
                    </div>

                    <button
                      type="submit"
                      className="w-full py-3 sm:py-2.5 mt-2 bg-zinc-100 hover:bg-white text-zinc-950 font-medium rounded-lg transition-colors flex items-center justify-center gap-2 text-sm"
                    >
                      <Plus className="w-4 h-4" />
                      确认添加记录
                    </button>
                  </form>

                  <div className="mt-4 pt-4 border-t border-zinc-800 flex gap-3">
                    <button
                      onClick={handleExport}
                      className="flex-1 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 rounded-lg transition-colors flex items-center justify-center gap-2 text-xs font-medium"
                    >
                      <Download className="w-3.5 h-3.5" />
                      导出备份
                    </button>
                    <label className="flex-1 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 rounded-lg transition-colors flex items-center justify-center gap-2 text-xs font-medium cursor-pointer">
                      <Upload className="w-3.5 h-3.5" />
                      导入数据
                      <input 
                        type="file" 
                        accept=".json" 
                        onChange={handleImport} 
                        className="hidden" 
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {/* ANALYSIS TAB */}
        {activeTab === 'analysis' && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-1 lg:grid-cols-12 gap-6 sm:gap-8">
            
            {/* Left Column: Input Form */}
            <div className="lg:col-span-4 space-y-6">
              <div>
                <h2 className="text-lg sm:text-xl font-medium text-zinc-100 mb-1">量化分析终端</h2>
                <p className="text-xs sm:text-sm text-zinc-500">结合您的真实持仓与市场数据进行深度分析</p>
              </div>

              <form onSubmit={handleAnalyze} className="space-y-5">
                {/* Network Toggle */}
                <div className="flex items-center justify-between p-3 sm:p-4 rounded-xl bg-zinc-900/50 border border-zinc-800">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${useNetwork ? 'bg-blue-500/10 text-blue-400' : 'bg-zinc-800 text-zinc-500'}`}>
                      <Globe className="w-4 h-4" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-zinc-200">联网增强分析</p>
                      <p className="text-xs text-zinc-500">AI将自动搜索最新实时行情</p>
                    </div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input 
                      type="checkbox" 
                      className="sr-only peer" 
                      checked={useNetwork}
                      onChange={() => setUseNetwork(!useNetwork)}
                    />
                    <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                  </label>
                </div>

                {/* Market Data Input */}
                <div className="space-y-2">
                  <label htmlFor="marketData" className="flex items-center gap-2 text-sm font-medium text-zinc-300">
                    <Activity className="w-4 h-4 text-zinc-400" />
                    大盘/宏观关注点 (可选)
                  </label>
                  <textarea
                    id="marketData"
                    value={marketData}
                    onChange={(e) => setMarketData(e.target.value)}
                    placeholder="例如：关注美联储降息对A股的影响..."
                    className="w-full h-20 sm:h-24 bg-zinc-900/50 border border-zinc-800 rounded-xl p-3 text-base sm:text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500/50 transition-all resize-none custom-scrollbar"
                  />
                </div>

                {/* Stock Info Input */}
                <div className="space-y-2">
                  <label htmlFor="stockInfo" className="flex items-center gap-2 text-sm font-medium text-zinc-300">
                    <TrendingUp className="w-4 h-4 text-zinc-400" />
                    个股关注点 (可选)
                  </label>
                  <textarea
                    id="stockInfo"
                    value={stockInfo}
                    onChange={(e) => setStockInfo(e.target.value)}
                    placeholder="例如：帮我查一下宁德时代最新的财报和机构评级..."
                    className="w-full h-20 sm:h-24 bg-zinc-900/50 border border-zinc-800 rounded-xl p-3 text-base sm:text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500/50 transition-all resize-none custom-scrollbar"
                  />
                </div>

                {/* Holdings Input */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label htmlFor="holdingsInput" className="flex items-center gap-2 text-sm font-medium text-zinc-300">
                      <Briefcase className="w-4 h-4 text-zinc-400" />
                      个人持股仓位
                    </label>
                    <button 
                      type="button"
                      onClick={syncHoldingsToAnalysis}
                      className="text-xs flex items-center gap-1 text-emerald-500 hover:text-emerald-400 transition-colors py-1 px-2 rounded bg-emerald-500/10"
                    >
                      <RefreshCw className="w-3 h-3" />
                      从持仓同步
                    </button>
                  </div>
                  <textarea
                    id="holdingsInput"
                    value={holdingsInput}
                    onChange={(e) => setHoldingsInput(e.target.value)}
                    placeholder="您的持仓信息将在此处显示..."
                    className="w-full h-28 sm:h-32 bg-zinc-900/50 border border-zinc-800 rounded-xl p-3 text-base sm:text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500/50 transition-all resize-none custom-scrollbar font-mono"
                  />
                </div>

                {error && (
                  <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 flex items-start gap-2 text-sm text-red-400">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <p>{error}</p>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3.5 sm:py-3 px-4 bg-zinc-100 hover:bg-white text-zinc-950 font-medium rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin" />
                      正在执行量化分析...
                    </>
                  ) : (
                    <>
                      <LineChartIcon className="w-5 h-5 sm:w-4 sm:h-4" />
                      获取专业分析
                    </>
                  )}
                </button>
              </form>
            </div>

            {/* Right Column: Analysis Result */}
            <div className="lg:col-span-8">
              <div className="h-full min-h-[500px] sm:min-h-[600px] bg-zinc-900/30 border border-zinc-800 rounded-2xl p-4 sm:p-6 relative overflow-hidden">
                {/* Decorative background grid */}
                <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] pointer-events-none"></div>
                
                <div className="relative z-10 h-full flex flex-col">
                  <div className="flex items-center justify-between mb-4 sm:mb-6 pb-3 sm:pb-4 border-b border-zinc-800/50">
                    <h3 className="text-xs sm:text-sm font-mono text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                      <Terminal className="w-4 h-4" />
                      Analysis Output
                    </h3>
                    {result && (
                      <span className="text-[10px] sm:text-xs font-mono text-emerald-500 bg-emerald-500/10 px-2 py-1 rounded border border-emerald-500/20">
                        COMPLETED
                      </span>
                    )}
                  </div>

                  <div className="flex-1 overflow-y-auto pr-1 sm:pr-2 custom-scrollbar">
                    {!result && !loading && (
                      <div className="h-full flex flex-col items-center justify-center text-zinc-600 space-y-4 py-12">
                        <LineChartIcon className="w-10 h-10 sm:w-12 sm:h-12 opacity-20" />
                        <p className="text-sm text-center px-4">等待输入数据以生成分析报告<br/><span className="text-xs opacity-70 mt-2 block">开启"联网增强分析"可获取最新实时行情</span></p>
                      </div>
                    )}

                    {loading && (
                      <div className="h-full flex flex-col items-center justify-center text-zinc-500 space-y-4 py-12">
                        <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
                        <div className="flex flex-col items-center gap-1">
                          <p className="text-sm font-mono animate-pulse">Processing market data...</p>
                          {useNetwork && <p className="text-xs font-mono text-blue-400/80">Searching real-time web data...</p>}
                          <p className="text-xs font-mono opacity-50">Running quantitative models</p>
                        </div>
                      </div>
                    )}

                    {result && (
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.4 }}
                        className="markdown-body text-sm sm:text-base"
                      >
                        <ReactMarkdown>{result}</ReactMarkdown>
                      </motion.div>
                    )}
                  </div>
                </div>
              </div>
            </div>

          </motion.div>
        )}

        {/* Chart Modal */}
        {selectedStock && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl w-full max-w-4xl overflow-hidden flex flex-col"
            >
              <div className="flex items-center justify-between p-4 sm:p-5 border-b border-zinc-800 bg-zinc-900/50">
                <div>
                  <h3 className="text-lg font-medium text-zinc-100 flex items-center gap-2">
                    {selectedStock.name} <span className="text-sm font-mono text-zinc-500">{selectedStock.symbol}</span>
                  </h3>
                  <div className="text-sm text-zinc-400 mt-1">日K线走势图 (近50个交易日)</div>
                </div>
                <button 
                  onClick={() => setSelectedStock(null)}
                  className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              
              <div className="p-4 sm:p-6 h-[400px] sm:h-[500px] w-full">
                {klineLoading ? (
                  <div className="h-full flex flex-col items-center justify-center text-zinc-500 space-y-4">
                    <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
                    <p className="text-sm font-mono">加载K线数据中...</p>
                  </div>
                ) : klineData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={klineData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorClose" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="#f43f5e" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <XAxis 
                        dataKey="date" 
                        stroke="#52525b" 
                        fontSize={12} 
                        tickFormatter={(val) => val.substring(5)} 
                        minTickGap={30}
                      />
                      <YAxis 
                        domain={['auto', 'auto']} 
                        stroke="#52525b" 
                        fontSize={12} 
                        tickFormatter={(val) => val.toFixed(2)}
                        orientation="right"
                      />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', borderRadius: '8px' }}
                        itemStyle={{ color: '#e4e4e7' }}
                        labelStyle={{ color: '#a1a1aa', marginBottom: '4px' }}
                      />
                      <Area 
                        type="monotone" 
                        dataKey="close" 
                        name="收盘价"
                        stroke="#f43f5e" 
                        strokeWidth={2}
                        fillOpacity={1} 
                        fill="url(#colorClose)" 
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-zinc-500">
                    暂无K线数据
                  </div>
                )}
              </div>
              
              <div className="p-4 border-t border-zinc-800 bg-zinc-900/50 flex justify-end gap-3">
                <button 
                  onClick={() => {
                    handleQuickTrade(selectedStock, 'BUY');
                    setSelectedStock(null);
                  }}
                  className="px-4 py-2 rounded-lg bg-rose-500/10 text-rose-500 hover:bg-rose-500/20 transition-colors font-medium text-sm"
                >
                  快捷买入
                </button>
                <button 
                  onClick={() => {
                    handleQuickTrade(selectedStock, 'SELL');
                    setSelectedStock(null);
                  }}
                  className="px-4 py-2 rounded-lg bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 transition-colors font-medium text-sm"
                >
                  快捷卖出
                </button>
              </div>
            </motion.div>
          </div>
        )}

      </main>
    </div>
  );
}
