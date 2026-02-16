import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { Skull, Crosshair, Trophy, Play } from 'lucide-react';

// --- CONFIGURATIE ---
const SERVER_URL = "https://insured-manufacturer-mode-continuing.trycloudflare.com/";

// --- GAME BALANS ---
const ACCELERATION = 0.4; 
const FRICTION = 0.92;
const MAX_SPEED = 5; 
const DASH_SPEED = 18; 
const DASH_COOLDOWN = 5000;
const BULLET_SPEED = 16;
const RELOAD_TIME = 400; // Iets sneller schieten voor betere gameplay
const MAP_WIDTH = 2400;  
const MAP_HEIGHT = 1800; 
const BULLET_LIFESPAN = 1500; 
const WIN_SCORE = 5;
const MOUSE_DEADZONE = 60; 

const OBSTACLES = [
  { x: 1000, y: 700, w: 400, h: 400 }, 
  { x: 400, y: 400, w: 200, h: 50 },
  { x: 1800, y: 400, w: 200, h: 50 },
  { x: 400, y: 1350, w: 200, h: 50 },
  { x: 1800, y: 1350, w: 200, h: 50 },
  { x: 200, y: 600, w: 50, h: 600 },
  { x: 2150, y: 600, w: 50, h: 600 },
  { x: 700, y: 300, w: 100, h: 100 },
  { x: 1600, y: 300, w: 100, h: 100 },
  { x: 700, y: 1400, w: 100, h: 100 },
  { x: 1600, y: 1400, w: 100, h: 100 },
];

// Helper om te checken of een punt in een obstakel zit
function isInObstacle(x, y, margin = 40) {
  return OBSTACLES.some(o => 
    x > o.x - margin && x < o.x + o.w + margin &&
    y > o.y - margin && y < o.y + o.h + margin
  );
}

// Zoek een veilige spawnplek
function findSafeSpawn() {
  let attempts = 0;
  while (attempts < 100) {
    const x = Math.random() * (MAP_WIDTH - 200) + 100;
    const y = Math.random() * (MAP_HEIGHT - 200) + 100;
    if (!isInObstacle(x, y)) return { x, y };
    attempts++;
  }
  return { x: 1200, y: 900 }; // Fallback
}

export default function App() {
  const [socket, setSocket] = useState(null);
  const [gameState, setGameState] = useState('MENU'); 
  const [lobbyCode, setLobbyCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [lobbyData, setLobbyData] = useState(null);
  const [screenSize, setScreenSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [deathTimer, setDeathTimer] = useState(0);

  // Refs voor game state en input
  const gameStateRef = useRef(gameState);
  const canvasRef = useRef(null);
  const pos = useRef({ x: 1200, y: 900 });
  const vel = useRef({ x: 0, y: 0 });
  const mousePosScreen = useRef({ x: 0, y: 0 }); 
  const keysPressed = useRef({});
  const lastShotTime = useRef(0);
  const lastDashTime = useRef(0);
  const frameRef = useRef();
  const deathIntervalRef = useRef();

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  // 1. Socket Verbinding
  useEffect(() => {
    const s = io(SERVER_URL);
    setSocket(s);

    s.on('lobbyUpdate', (data) => {
      setLobbyData(data);
      
      // START SPEL LOGICA
      if (data.status === 'PLAYING' && gameStateRef.current === 'LOBBY') {
        const myData = data.players[s.id];
        // Gebruik server positie, OF zoek zelf een veilige plek als de server ons in een muur zet
        let startX = myData ? myData.x : 1200;
        let startY = myData ? myData.y : 900;

        if (isInObstacle(startX, startY)) {
           const safe = findSafeSpawn();
           startX = safe.x;
           startY = safe.y;
           // Stuur correctie naar server
           s.emit('move', { x: startX, y: startY });
        }

        pos.current = { x: startX, y: startY };
        vel.current = { x: 0, y: 0 };
        setGameState('PLAYING');
      }

      if (data.winner) setGameState('WINNER');

      if (gameStateRef.current === 'PLAYING' && data.players[s.id]?.alive === false) {
        startDeathSequence(s);
      }
    });

    const handleResize = () => setScreenSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', handleResize);
    window.addEventListener('keydown', (e) => keysPressed.current[e.key] = true);
    window.addEventListener('keyup', (e) => keysPressed.current[e.key] = false);

    return () => {
      s.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, []); 

  // 2. Game Loop
  useEffect(() => {
    if (gameState !== 'PLAYING') return;

    const render = () => {
      updatePhysics();
      draw();
      frameRef.current = requestAnimationFrame(render);
    };

    frameRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frameRef.current);
  }, [gameState, lobbyData, screenSize]);

  const startDeathSequence = (currentSocket) => {
    if (gameStateRef.current === 'DEAD') return;
    setGameState('DEAD');
    setDeathTimer(5);
    
    if (deathIntervalRef.current) clearInterval(deathIntervalRef.current);
    
    deathIntervalRef.current = setInterval(() => {
      setDeathTimer(prev => {
        if (prev <= 1) {
          clearInterval(deathIntervalRef.current);
          
          // Respawn op veilige plek
          const safe = findSafeSpawn();
          pos.current = safe;
          currentSocket.emit('move', safe); // Sync positie
          currentSocket.emit('respawn');
          
          setGameState('PLAYING');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const performShoot = () => {
      if (Date.now() - lastShotTime.current < RELOAD_TIME) return;

      const camX = pos.current.x - screenSize.w / 2;
      const camY = pos.current.y - screenSize.h / 2;
      const worldMouseX = mousePosScreen.current.x + camX;
      const worldMouseY = mousePosScreen.current.y + camY;
      
      const bdx = worldMouseX - pos.current.x;
      const bdy = worldMouseY - pos.current.y;
      const bdist = Math.sqrt(bdx*bdx + bdy*bdy);
      
      if (bdist > 1) {
        socket.emit('shoot', {
          x: pos.current.x,
          y: pos.current.y,
          vx: (bdx / bdist) * BULLET_SPEED,
          vy: (bdy / bdist) * BULLET_SPEED
        });
        lastShotTime.current = Date.now();
      }
  };

  const updatePhysics = () => {
    if (!socket || !lobbyData) return;

    const centerX = screenSize.w / 2;
    const centerY = screenSize.h / 2;
    const dx = mousePosScreen.current.x - centerX;
    const dy = mousePosScreen.current.y - centerY;
    const dist = Math.sqrt(dx*dx + dy*dy);

    if (dist > MOUSE_DEADZONE) {
      vel.current.x += (dx / dist) * ACCELERATION;
      vel.current.y += (dy / dist) * ACCELERATION;
    }

    if (keysPressed.current['Shift'] && Date.now() - lastDashTime.current > DASH_COOLDOWN) {
      const normX = dist > 0 ? dx / dist : 1;
      const normY = dist > 0 ? dy / dist : 0;
      vel.current.x += normX * DASH_SPEED;
      vel.current.y += normY * DASH_SPEED;
      lastDashTime.current = Date.now();
    }

    vel.current.x *= FRICTION;
    vel.current.y *= FRICTION;

    // Snelheidslimiet
    const speed = Math.sqrt(vel.current.x**2 + vel.current.y**2);
    const cap = (Date.now() - lastDashTime.current < 300) ? DASH_SPEED : MAX_SPEED;
    if (speed > cap) {
      vel.current.x = (vel.current.x / speed) * cap;
      vel.current.y = (vel.current.y / speed) * cap;
    }

    // Nieuwe positie berekenen
    let nextX = pos.current.x + vel.current.x;
    let nextY = pos.current.y + vel.current.y;
    const r = 20;

    // Map grenzen
    if (nextX < r) nextX = r; if (nextX > MAP_WIDTH - r) nextX = MAP_WIDTH - r;
    if (nextY < r) nextY = r; if (nextY > MAP_HEIGHT - r) nextY = MAP_HEIGHT - r;

    // Obstakel botsing (X-as)
    if (!isInObstacle(nextX, pos.current.y, r)) {
        pos.current.x = nextX;
    } else {
        vel.current.x *= 0.5; // Stuiteren
    }

    // Obstakel botsing (Y-as)
    if (!isInObstacle(pos.current.x, nextY, r)) {
        pos.current.y = nextY;
    } else {
        vel.current.y *= 0.5; // Stuiteren
    }

    // Schieten met Spatie (optioneel)
    if (keysPressed.current[' ']) {
        performShoot();
    }

    socket.emit('move', { x: pos.current.x, y: pos.current.y });
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const camX = pos.current.x - screenSize.w / 2;
    const camY = pos.current.y - screenSize.h / 2;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, screenSize.w, screenSize.h);

    ctx.save();
    ctx.translate(-camX, -camY);

    // Raster
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= MAP_WIDTH; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, MAP_HEIGHT); }
    for (let y = 0; y <= MAP_HEIGHT; y += 100) { ctx.moveTo(0, y); ctx.lineTo(MAP_WIDTH, y); }
    ctx.stroke();

    // Obstakels
    ctx.fillStyle = '#334155';
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 4;
    OBSTACLES.forEach(o => {
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeRect(o.x, o.y, o.w, o.h);
    });

    // Kogels
    const now = Date.now();
    ctx.fillStyle = '#fbbf24';
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#fbbf24';
    lobbyData?.bullets?.forEach(b => {
      const age = (now - b.createdAt) / 1000;
      if (age < BULLET_LIFESPAN / 1000) {
        const bx = b.x + b.vx * age * 60;
        const by = b.y + b.vy * age * 60;
        ctx.beginPath();
        ctx.arc(bx, by, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.shadowBlur = 0;

    // Spelers
    Object.entries(lobbyData?.players || {}).forEach(([id, p]) => {
      if (!p.alive) return;
      const isMe = id === socket.id;
      ctx.fillStyle = isMe ? '#3b82f6' : '#ef4444';
      if (isMe) {
        ctx.shadowBlur = 20;
        ctx.shadowColor = 'rgba(59, 130, 246, 0.5)';
      }
      ctx.beginPath();
      const drawX = isMe ? pos.current.x : p.x;
      const drawY = isMe ? pos.current.y : p.y;
      ctx.arc(drawX, drawY, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(isMe ? "JIJ" : p.name, drawX, drawY - 30);
      
      if (p.score > 0) {
        ctx.font = '10px sans-serif';
        ctx.fillStyle = '#fbbf24';
        ctx.fillText(`★ ${p.score}`, drawX, drawY - 42);
      }
    });

    // Balkjes (Reload & Dash)
    const timeSinceShot = now - lastShotTime.current;
    if (timeSinceShot < RELOAD_TIME) {
      const pct = timeSinceShot / RELOAD_TIME;
      ctx.fillStyle = '#334155';
      ctx.fillRect(pos.current.x - 20, pos.current.y + 30, 40, 4);
      ctx.fillStyle = '#fff';
      ctx.fillRect(pos.current.x - 20, pos.current.y + 30, 40 * pct, 4);
    }

    const timeSinceDash = now - lastDashTime.current;
    if (timeSinceDash < DASH_COOLDOWN) {
      const pct = timeSinceDash / DASH_COOLDOWN;
      ctx.fillStyle = '#1e3a8a';
      ctx.fillRect(pos.current.x - 20, pos.current.y + 36, 40, 4);
      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(pos.current.x - 20, pos.current.y + 36, 40 * pct, 4);
    }
    ctx.restore();

    // --- CROSSHAIR TEKENEN ---
    const mx = mousePosScreen.current.x;
    const my = mousePosScreen.current.y;
    
    // Cirkel
    ctx.strokeStyle = '#10b981'; // Emerald groen
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mx, my, 12, 0, Math.PI * 2);
    ctx.stroke();

    // Dot in midden
    ctx.fillStyle = '#10b981';
    ctx.beginPath();
    ctx.arc(mx, my, 2, 0, Math.PI * 2);
    ctx.fill();

    // Minimap
    const mmScale = 0.08;
    const mmW = MAP_WIDTH * mmScale;
    const mmH = MAP_HEIGHT * mmScale;
    const mmX = screenSize.w - mmW - 20;
    const mmY = 20;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
    ctx.fillRect(mmX, mmY, mmW, mmH);
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 2;
    ctx.strokeRect(mmX, mmY, mmW, mmH);
    
    Object.entries(lobbyData?.players || {}).forEach(([id, p]) => {
      if (!p.alive) return;
      ctx.fillStyle = id === socket.id ? '#3b82f6' : '#ef4444';
      ctx.beginPath();
      const px = id === socket.id ? pos.current.x : p.x;
      const py = id === socket.id ? pos.current.y : p.y;
      ctx.arc(mmX + px * mmScale, mmY + py * mmScale, 3, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText("KLIK = Schieten | SHIFT = Dash", 20, screenSize.h - 20);
  };

  const join = () => {
    if (!playerName || !lobbyCode || !socket) return;
    socket.emit('joinLobby', { lobbyCode: lobbyCode.toUpperCase(), playerName });
    setGameState('LOBBY');
  };

  const startMatch = () => {
    socket.emit('startMatch');
  };

  if (gameState === 'MENU') return (
    <div className="w-full h-screen bg-slate-950 flex items-center justify-center text-white font-sans overflow-hidden">
      <div className="bg-slate-900 p-12 rounded-[3rem] shadow-2xl w-full max-w-sm border-b-8 border-emerald-500/20 text-center">
        <Crosshair size={60} className="text-emerald-400 mx-auto mb-6 animate-pulse" />
        <h1 className="text-5xl font-black mb-10 italic tracking-tighter">BOOM.IO</h1>
        <input className="w-full bg-slate-800 p-4 rounded-2xl mb-4 border border-slate-700 outline-none focus:border-emerald-500 text-white" placeholder="JOUW NAAM" value={playerName} onChange={e => setPlayerName(e.target.value)} />
        <input className="w-full bg-slate-800 p-4 rounded-2xl mb-8 border border-slate-700 outline-none focus:border-emerald-500 uppercase text-white font-bold" placeholder="LOBBY CODE" value={lobbyCode} onChange={e => setLobbyCode(e.target.value)} />
        <button onClick={join} className="w-full bg-emerald-500 py-5 rounded-2xl font-black text-xl hover:bg-emerald-400 text-slate-900 shadow-[0_6px_0_rgb(16,185,129)] active:translate-y-1 transition-all uppercase">Speel Nu</button>
      </div>
    </div>
  );

  if (gameState === 'LOBBY') return (
    <div className="w-full h-screen bg-slate-950 flex items-center justify-center text-white font-sans overflow-hidden">
      <div className="bg-slate-900 p-10 rounded-[2.5rem] w-full max-w-md text-center border-b-8 border-blue-500/20">
        <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold text-slate-400 uppercase tracking-wide">Lobby: {lobbyCode}</h2>
            <div className="bg-emerald-500/10 text-emerald-400 px-3 py-1 rounded-full text-xs font-bold">Doel: {WIN_SCORE}</div>
        </div>
        <div className="space-y-3 mb-10 max-h-60 overflow-y-auto">
          {Object.values(lobbyData?.players || {}).map((p, i) => (
            <div key={i} className="bg-slate-800 p-4 rounded-2xl border border-slate-700 flex justify-between font-bold items-center">
              <span className="flex items-center gap-2"><div className="w-2 h-2 bg-blue-500 rounded-full"/> {p.name}</span>
              <span className="text-emerald-400 text-xs font-black uppercase tracking-widest">Gereed</span>
            </div>
          ))}
        </div>
        <button onClick={startMatch} className="w-full bg-blue-500 py-5 rounded-2xl font-black shadow-[0_6px_0_rgb(59,130,246)] uppercase flex items-center justify-center gap-2 text-white hover:bg-blue-400 transition-colors"><Play size={20}/> Start Match</button>
      </div>
    </div>
  );

  if (gameState === 'WINNER') return (
    <div className="fixed inset-0 bg-slate-950 flex items-center justify-center z-[200] text-white">
        <div className="text-center">
            <Trophy size={100} className="text-yellow-400 mx-auto mb-6 animate-bounce" />
            <h1 className="text-6xl font-black mb-4 uppercase text-yellow-400 tracking-tighter">Winnaar!</h1>
            <p className="text-4xl font-bold mb-10 text-white">{lobbyData?.winner}</p>
            <button onClick={() => window.location.reload()} className="bg-white text-slate-900 px-10 py-5 rounded-full font-black uppercase hover:bg-emerald-400 transition-colors">Terug naar Menu</button>
        </div>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black overflow-hidden cursor-none">
      <canvas 
        ref={canvasRef}
        width={screenSize.w}
        height={screenSize.h}
        onMouseMove={e => mousePosScreen.current = { x: e.clientX, y: e.clientY }}
        onMouseDown={performShoot} // KLIK OM TE SCHIETEN TOEGEVOEGD
      />
      <div className="absolute top-4 left-4 bg-black/40 p-4 rounded-xl backdrop-blur-sm border border-white/10 text-white pointer-events-none select-none">
         <h3 className="font-bold text-xs uppercase text-slate-400 mb-2 italic">Top Spelers</h3>
         {Object.values(lobbyData?.players || {})
            .sort((a,b) => b.score - a.score)
            .map((p, i) => (
             <div key={i} className="flex justify-between w-40 text-sm mb-1">
                 <span className={p.id === socket?.id ? "text-blue-400 font-bold" : "text-white"}>{i+1}. {p.name}</span>
                 <span className="font-mono text-yellow-400 font-bold">{p.score || 0}</span>
             </div>
         ))}
      </div>

      {gameState === 'DEAD' && (
        <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-[100] text-white">
          <div className="text-center">
            <Skull size={80} className="text-rose-500 mx-auto mb-6 animate-pulse" />
            <h2 className="text-5xl font-black mb-4 uppercase italic tracking-tighter">Eliminatie</h2>
            <p className="text-xl text-slate-400 mb-8 tracking-widest uppercase">Respawn in <span className="text-white font-mono text-3xl font-bold">{deathTimer}</span></p>
            <div className="w-64 h-2 bg-slate-800 rounded-full mx-auto overflow-hidden">
                <div className="h-full bg-rose-500 transition-all duration-1000 ease-linear" style={{ width: `${(deathTimer/5)*100}%` }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
