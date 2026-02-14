import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  onAuthStateChanged,
  signInWithCustomToken
} from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  onSnapshot, 
  updateDoc
} from 'firebase/firestore';
import { Skull, RotateCcw, Crosshair, Users } from 'lucide-react';

// --- CONFIGURATIE ---
const FIREBASE_CONFIG = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
  apiKey: "AIzaSyDw-WSx1oYTHzadXUB7csmKNhZlO0RTw6Y",
  authDomain: "multiplayer-shooter-c0b9f.firebaseapp.com",
  projectId: "multiplayer-shooter-c0b9f",
  storageBucket: "multiplayer-shooter-c0b9f.firebasestorage.app",
  messagingSenderId: "773037810608",
  appId: "1:773037810608:web:f8b22fc68fa1e0c34f2c75"
};

const APP_ID = typeof __app_id !== 'undefined' ? __app_id : 'boom-io-v3';
const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

// Game Constanten
const ACCELERATION = 0.8;
const FRICTION = 0.90;
const MAX_SPEED = 8;
const BULLET_SPEED = 18;
const RELOAD_TIME = 250; 
const MAP_WIDTH = 2000;  
const MAP_HEIGHT = 1500; 
const VIEWPORT_W = 800;
const VIEWPORT_H = 600;
const BULLET_LIFESPAN = 1000; 

const OBSTACLES = [
  { x: 900, y: 700, w: 200, h: 100 },
  { x: 400, y: 300, w: 500, h: 40 },
  { x: 1200, y: 300, w: 500, h: 40 },
  { x: 200, y: 600, w: 60, h: 300 },
  { x: 1740, y: 600, w: 60, h: 300 },
  { x: 500, y: 1100, w: 1000, h: 40 },
];

export default function App() {
  const [user, setUser] = useState(null);
  const [gameState, setGameState] = useState('MENU'); 
  const [lobbyCode, setLobbyCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [lobbyData, setLobbyData] = useState(null);

  const canvasRef = useRef(null);
  const pos = useRef({ x: 1000, y: 750 });
  const vel = useRef({ x: 0, y: 0 });
  const mousePosRaw = useRef({ x: 0, y: 0 });
  const keysPressed = useRef({});
  const isMouseDown = useRef(false);
  const lastShotTime = useRef(0);
  const lastUpdateToDb = useRef(0);
  const frameRef = useRef();

  // Firebase Auth
  useEffect(() => {
    const initAuth = async () => {
      if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
        await signInWithCustomToken(auth, __initial_auth_token);
      } else {
        await signInAnonymously(auth);
      }
    };
    initAuth();
    return onAuthStateChanged(auth, setUser);
  }, []);

  // Lobby Sync
  useEffect(() => {
    if (!user || !lobbyCode || gameState === 'MENU') return;
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    return onSnapshot(lobbyRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setLobbyData(data);
        if (data.status === 'PLAYING' && gameState === 'LOBBY') setGameState('PLAYING');
        if (gameState === 'PLAYING' && data.players?.[user.uid]?.alive === false) setGameState('DEAD');
      }
    });
  }, [user, lobbyCode, gameState]);

  // Game Loop & Canvas Rendering
  useEffect(() => {
    if (gameState !== 'PLAYING') return;

    const render = () => {
      updatePhysics();
      draw();
      frameRef.current = requestAnimationFrame(render);
    };

    frameRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frameRef.current);
  }, [gameState, lobbyData]);

  const updatePhysics = () => {
    const cameraX = pos.current.x - VIEWPORT_W / 2;
    const cameraY = pos.current.y - VIEWPORT_H / 2;
    const worldMouseX = mousePosRaw.current.x + cameraX;
    const worldMouseY = mousePosRaw.current.y + cameraY;

    // Beweging
    const dx = worldMouseX - pos.current.x;
    const dy = worldMouseY - pos.current.y;
    const dist = Math.sqrt(dx*dx + dy*dy);

    if (dist > 10) {
      vel.current.x += (dx / dist) * ACCELERATION;
      vel.current.y += (dy / dist) * ACCELERATION;
    }

    vel.current.x *= FRICTION;
    vel.current.y *= FRICTION;

    // Collision
    const nextX = pos.current.x + vel.current.x;
    const nextY = pos.current.y + vel.current.y;
    const r = 15;

    let canMoveX = nextX > r && nextX < MAP_WIDTH - r;
    let canMoveY = nextY > r && nextY < MAP_HEIGHT - r;

    for (let obs of OBSTACLES) {
      if (nextX + r > obs.x && nextX - r < obs.x + obs.w && pos.current.y + r > obs.y && pos.current.y - r < obs.y + obs.h) canMoveX = false;
      if (pos.current.x + r > obs.x && pos.current.x - r < obs.x + obs.w && nextY + r > obs.y && nextY - r < obs.y + obs.h) canMoveY = false;
    }

    if (canMoveX) pos.current.x = nextX; else vel.current.x = 0;
    if (canMoveY) pos.current.y = nextY; else vel.current.y = 0;

    // Schieten
    if ((keysPressed.current[' '] || isMouseDown.current) && Date.now() - lastShotTime.current > RELOAD_TIME) {
      shoot(worldMouseX, worldMouseY);
    }

    // Hit detection
    if (lobbyData?.bullets) {
      const now = Date.now();
      lobbyData.bullets.forEach(b => {
        if (b.ownerId !== user.uid) {
          const age = (now - b.createdAt) / 1000;
          const bx = b.x + b.vx * age * 60;
          const by = b.y + b.vy * age * 60;
          const d = Math.sqrt((bx - pos.current.x)**2 + (by - pos.current.y)**2);
          if (d < 25) die();
        }
      });
    }

    // Sync
    if (Date.now() - lastUpdateToDb.current > 50) {
      sync();
      lastUpdateToDb.current = Date.now();
    }
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    const camX = pos.current.x - VIEWPORT_W / 2;
    const camY = pos.current.y - VIEWPORT_H / 2;

    // Clear
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, VIEWPORT_W, VIEWPORT_H);

    ctx.save();
    ctx.translate(-camX, -camY);

    // Grid
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    for (let x = 0; x <= MAP_WIDTH; x += 100) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, MAP_HEIGHT); ctx.stroke();
    }
    for (let y = 0; y <= MAP_HEIGHT; y += 100) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(MAP_WIDTH, y); ctx.stroke();
    }

    // Muren
    ctx.fillStyle = '#334155';
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 4;
    OBSTACLES.forEach(o => {
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeRect(o.x, o.y, o.w, o.h);
    });

    // Kogels
    const now = Date.now();
    ctx.fillStyle = '#fff';
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#fff';
    lobbyData?.bullets?.forEach(b => {
      const age = (now - b.createdAt) / 1000;
      if (age < BULLET_LIFESPAN / 1000) {
        const bx = b.x + b.vx * age * 60;
        const by = b.y + b.vy * age * 60;
        ctx.beginPath();
        ctx.arc(bx, by, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.shadowBlur = 0;

    // Andere spelers
    Object.entries(lobbyData?.players || {}).forEach(([id, p]) => {
      if (id === user.uid || !p.alive) return;
      ctx.fillStyle = '#e11d48';
      ctx.beginPath();
      ctx.roundRect(p.x - 20, p.y - 20, 40, 40, 8);
      ctx.fill();
      
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(p.name, p.x, p.y - 30);
    });

    // Jijzelf
    ctx.fillStyle = '#2563eb';
    ctx.shadowBlur = 15;
    ctx.shadowColor = '#3b82f6';
    ctx.beginPath();
    ctx.roundRect(pos.current.x - 20, pos.current.y - 20, 40, 40, 10);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.restore();

    // UI - Crosshair
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mousePosRaw.current.x, mousePosRaw.current.y, 10, 0, Math.PI*2);
    ctx.moveTo(mousePosRaw.current.x - 15, mousePosRaw.current.y);
    ctx.lineTo(mousePosRaw.current.x + 15, mousePosRaw.current.y);
    ctx.moveTo(mousePosRaw.current.x, mousePosRaw.current.y - 15);
    ctx.lineTo(mousePosRaw.current.x, mousePosRaw.current.y + 15);
    ctx.stroke();
  };

  const sync = () => {
    const ref = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    updateDoc(ref, {
      [`players.${user.uid}.x`]: pos.current.x,
      [`players.${user.uid}.y`]: pos.current.y,
    }).catch(() => {});
  };

  const shoot = (tx, ty) => {
    lastShotTime.current = Date.now();
    const dx = tx - pos.current.x;
    const dy = ty - pos.current.y;
    const d = Math.sqrt(dx*dx + dy*dy);
    const b = {
      id: Math.random().toString(36),
      ownerId: user.uid,
      x: pos.current.x,
      y: pos.current.y,
      vx: (dx/d) * BULLET_SPEED,
      vy: (dy/d) * BULLET_SPEED,
      createdAt: Date.now()
    };
    const ref = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    const active = (lobbyData?.bullets || []).filter(blt => Date.now() - blt.createdAt < BULLET_LIFESPAN);
    updateDoc(ref, { bullets: [...active.slice(-10), b] });
  };

  const die = () => {
    setGameState('DEAD');
    const ref = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    updateDoc(ref, { [`players.${user.uid}.alive`]: false });
  };

  const join = async () => {
    if (!playerName || !lobbyCode) return;
    const ref = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await setDoc(ref, {
      status: 'WAITING',
      bullets: [],
      players: { [user.uid]: { name: playerName, alive: true, x: 1000, y: 750 } }
    }, { merge: true });
    setGameState('LOBBY');
  };

  const start = async () => {
    const ref = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await updateDoc(ref, { status: 'PLAYING' });
  };

  if (gameState === 'MENU') return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6 text-white font-sans">
      <div className="bg-slate-900 p-12 rounded-[3rem] shadow-2xl w-full max-w-sm border-b-8 border-emerald-500/20 text-center">
        <Crosshair size={60} className="text-emerald-400 mx-auto mb-6 animate-pulse" />
        <h1 className="text-5xl font-black mb-10 tracking-tighter italic italic">BOOM.IO</h1>
        <input className="w-full bg-slate-800 p-4 rounded-2xl mb-4 border border-slate-700 outline-none focus:border-emerald-500" placeholder="NAAM" value={playerName} onChange={e => setPlayerName(e.target.value)} />
        <input className="w-full bg-slate-800 p-4 rounded-2xl mb-8 border border-slate-700 outline-none focus:border-emerald-500 uppercase" placeholder="LOBBY CODE" value={lobbyCode} onChange={e => setLobbyCode(e.target.value)} />
        <button onClick={join} className="w-full bg-emerald-500 py-5 rounded-2xl font-black text-xl hover:bg-emerald-400 shadow-[0_6px_0_rgb(16,185,129)] active:translate-y-1 transition-all text-slate-900">SPEEL NU</button>
      </div>
    </div>
  );

  if (gameState === 'LOBBY') return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6 text-white font-sans">
      <div className="bg-slate-900 p-10 rounded-[2.5rem] w-full max-w-sm text-center border-b-8 border-blue-500/20">
        <Users size={40} className="text-blue-400 mx-auto mb-4" />
        <h2 className="text-2xl font-bold mb-6 text-slate-400 uppercase tracking-widest">Lobby: {lobbyCode}</h2>
        <div className="space-y-3 mb-10">
          {Object.values(lobbyData?.players || {}).map((p, i) => (
            <div key={i} className="bg-slate-800 p-4 rounded-2xl border border-slate-700 flex justify-between font-bold">
              <span>{p.name}</span>
              <span className="text-emerald-400 text-xs">READY</span>
            </div>
          ))}
        </div>
        <button onClick={start} className="w-full bg-blue-500 py-5 rounded-2xl font-black shadow-[0_6px_0_rgb(59,130,246)] uppercase">Start Match</button>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black flex items-center justify-center overflow-hidden cursor-none">
      <canvas 
        ref={canvasRef}
        width={VIEWPORT_W}
        height={VIEWPORT_H}
        className="bg-slate-900 rounded-lg shadow-2xl"
        onMouseMove={e => {
          const rect = canvasRef.current.getBoundingClientRect();
          mousePosRaw.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        }}
        onMouseDown={e => { if(e.button === 0) isMouseDown.current = true; }}
        onMouseUp={() => isMouseDown.current = false}
      />

      {gameState === 'DEAD' && (
        <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-md flex items-center justify-center z-[100]">
          <div className="text-center p-12 bg-slate-900 rounded-[3rem] border-b-8 border-rose-600 shadow-2xl max-w-xs w-full">
            <Skull size={64} className="text-rose-500 mx-auto mb-6" />
            <h2 className="text-4xl font-black mb-10 text-white uppercase italic">K.O.</h2>
            <button onClick={() => window.location.reload()} className="bg-white text-slate-950 px-8 py-5 rounded-2xl font-black text-lg hover:bg-emerald-400 transition-all flex items-center justify-center gap-3 w-full uppercase"><RotateCcw size={24} /> Herstart</button>
          </div>
        </div>
      )}
    </div>
  );
}