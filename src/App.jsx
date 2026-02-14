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
import { Skull, Crosshair, Trophy, Play } from 'lucide-react';

// --- CONFIGURATIE ---
const FIREBASE_CONFIG = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
  apiKey: "AIzaSyDw-WSx1oYTHzadXUB7csmKNhZlO0RTw6Y",
  authDomain: "multiplayer-shooter-c0b9f.firebaseapp.com",
  projectId: "multiplayer-shooter-c0b9f",
  storageBucket: "multiplayer-shooter-c0b9f.firebasestorage.app",
  messagingSenderId: "773037810608",
  appId: "1:773037810608:web:f8b22fc68fa1e0c34f2c75"
};

const APP_ID = typeof __app_id !== 'undefined' ? __app_id : 'boom-io-final-v5';
const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

// --- GAME BALANS ---
const ACCELERATION = 0.4; 
const FRICTION = 0.92;
const MAX_SPEED = 5; 
const DASH_SPEED = 18; 
const DASH_COOLDOWN = 5000;
const BULLET_SPEED = 16;
const RELOAD_TIME = 1000; 
const MAP_WIDTH = 2400;  
const MAP_HEIGHT = 1800; 
const BULLET_LIFESPAN = 1500; 
const WIN_SCORE = 5;
const MOUSE_DEADZONE = 60; 

// Obstakels
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

function isPointInRect(x, y, rect, margin = 0) {
  return x >= rect.x - margin && x <= rect.x + rect.w + margin && 
         y >= rect.y - margin && y <= rect.y + rect.h + margin;
}

function findSafeSpawn() {
  let safe = false;
  let spawn = { x: 1200, y: 900 };
  let attempts = 0;
  while (!safe && attempts < 100) {
    const tx = Math.random() * (MAP_WIDTH - 200) + 100;
    const ty = Math.random() * (MAP_HEIGHT - 200) + 100;
    let collision = false;
    for (let obs of OBSTACLES) {
      if (isPointInRect(tx, ty, obs, 60)) { collision = true; break; }
    }
    if (!collision) { spawn = { x: tx, y: ty }; safe = true; }
    attempts++;
  }
  return spawn;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [gameState, setGameState] = useState('MENU'); 
  const [lobbyCode, setLobbyCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [lobbyData, setLobbyData] = useState(null);
  const [screenSize, setScreenSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [deathTimer, setDeathTimer] = useState(0);

  const canvasRef = useRef(null);
  const pos = useRef({ x: 1200, y: 900 });
  const vel = useRef({ x: 0, y: 0 });
  const mousePosScreen = useRef({ x: 0, y: 0 }); 
  const keysPressed = useRef({});
  const lastShotTime = useRef(0);
  const lastDashTime = useRef(0);
  const lastUpdateToDb = useRef(0);
  const frameRef = useRef();
  const deathIntervalRef = useRef();

  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (err) {
        console.error("Auth error:", err);
      } finally {
        setLoading(false);
      }
    };
    initAuth();
    
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) setLoading(false);
    });

    const handleResize = () => setScreenSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', handleResize);
    
    return () => {
      window.removeEventListener('resize', handleResize);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!user || !lobbyCode || gameState === 'MENU') return;
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    
    const unsubscribe = onSnapshot(lobbyRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setLobbyData(data);
        
        if (data.status === 'PLAYING' && gameState === 'LOBBY') {
           const myStart = data.players?.[user.uid] || findSafeSpawn();
           pos.current = { x: myStart.x, y: myStart.y };
           vel.current = { x: 0, y: 0 };
           setGameState('PLAYING');
        }

        if (data.winner) {
            setGameState('WINNER');
        }

        if (gameState === 'PLAYING' && data.players?.[user.uid]?.alive === false) {
           startDeathSequence();
        }
      }
    }, (error) => console.error("Snapshot error:", error));

    return () => unsubscribe();
  }, [user, lobbyCode, gameState]);

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

  const startDeathSequence = () => {
      setGameState('DEAD');
      setDeathTimer(5);
      if (deathIntervalRef.current) clearInterval(deathIntervalRef.current);
      deathIntervalRef.current = setInterval(() => {
          setDeathTimer(prev => {
              if (prev <= 1) {
                  clearInterval(deathIntervalRef.current);
                  respawn();
                  return 0;
              }
              return prev - 1;
          });
      }, 1000);
  };

  const respawn = async () => {
      if (!user) return;
      const safe = findSafeSpawn();
      pos.current = safe;
      vel.current = { x: 0, y: 0 };
      const ref = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
      await updateDoc(ref, { 
          [`players.${user.uid}.alive`]: true,
          [`players.${user.uid}.x`]: safe.x,
          [`players.${user.uid}.y`]: safe.y
      });
      setGameState('PLAYING');
  };

  const updatePhysics = () => {
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

    const speed = Math.sqrt(vel.current.x**2 + vel.current.y**2);
    const cap = (Date.now() - lastDashTime.current < 300) ? DASH_SPEED : MAX_SPEED;
    
    if (speed > cap) {
        vel.current.x = (vel.current.x / speed) * cap;
        vel.current.y = (vel.current.y / speed) * cap;
    }

    let nextX = pos.current.x + vel.current.x;
    let nextY = pos.current.y + vel.current.y;
    const r = 20;

    if (nextX < r) nextX = r; if (nextX > MAP_WIDTH - r) nextX = MAP_WIDTH - r;
    if (nextY < r) nextY = r; if (nextY > MAP_HEIGHT - r) nextY = MAP_HEIGHT - r;

    let hitX = false;
    for (let obs of OBSTACLES) {
      if (nextX + r > obs.x && nextX - r < obs.x + obs.w && pos.current.y + r > obs.y && pos.current.y - r < obs.y + obs.h) hitX = true;
    }
    if (!hitX) pos.current.x = nextX; else vel.current.x *= 0.5;

    let hitY = false;
    for (let obs of OBSTACLES) {
      if (pos.current.x + r > obs.x && pos.current.x - r < obs.x + obs.w && nextY + r > obs.y && nextY - r < obs.y + obs.h) hitY = true;
    }
    if (!hitY) pos.current.y = nextY; else vel.current.y *= 0.5;

    if (keysPressed.current[' '] && Date.now() - lastShotTime.current > RELOAD_TIME) {
      const cameraX = pos.current.x - screenSize.w / 2;
      const cameraY = pos.current.y - screenSize.h / 2;
      const worldMouseX = mousePosScreen.current.x + cameraX;
      const worldMouseY = mousePosScreen.current.y + cameraY;
      shoot(worldMouseX, worldMouseY);
    }

    if (lobbyData?.bullets && user) {
      const now = Date.now();
      lobbyData.bullets.forEach(b => {
        if (b.ownerId !== user.uid) {
          const age = (now - b.createdAt) / 1000;
          const bx = b.x + b.vx * age * 60;
          const by = b.y + b.vy * age * 60;
          const d = Math.sqrt((bx - pos.current.x)**2 + (by - pos.current.y)**2);
          if (d < 25) die(b.ownerId);
        }
      });
    }

    if (Date.now() - lastUpdateToDb.current > 50 && user) {
      sync();
      lastUpdateToDb.current = Date.now();
    }
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

    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= MAP_WIDTH; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, MAP_HEIGHT); }
    for (let y = 0; y <= MAP_HEIGHT; y += 100) { ctx.moveTo(0, y); ctx.lineTo(MAP_WIDTH, y); }
    ctx.stroke();

    ctx.fillStyle = '#334155';
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 4;
    OBSTACLES.forEach(o => {
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeRect(o.x, o.y, o.w, o.h);
    });

    const now = Date.now();
    ctx.fillStyle = '#fbbf24';
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#fbbf24';
    lobbyData?.bullets?.forEach(b => {
      const age = (now - b.createdAt) / 1000;
      if (age < BULLET_LIFESPAN / 1000) {
        const bx = b.x + b.vx * age * 60;
        const by = b.y + b.vy * age * 60;
        let hitObs = false;
        for (let obs of OBSTACLES) {
             if (isPointInRect(bx, by, obs)) hitObs = true;
        }
        if (!hitObs) {
            ctx.beginPath();
            ctx.arc(bx, by, 5, 0, Math.PI * 2);
            ctx.fill();
        }
      }
    });
    ctx.shadowBlur = 0;

    Object.entries(lobbyData?.players || {}).forEach(([id, p]) => {
      if (!user || id === user.uid || !p.alive) return;
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(p.name, p.x, p.y - 30);
      if (p.score > 0) {
        ctx.font = '10px sans-serif';
        ctx.fillStyle = '#fbbf24';
        ctx.fillText(`★ ${p.score}`, p.x, p.y - 42);
      }
    });

    ctx.fillStyle = '#3b82f6';
    ctx.shadowBlur = 20;
    ctx.shadowColor = 'rgba(59, 130, 246, 0.5)';
    ctx.beginPath();
    ctx.arc(pos.current.x, pos.current.y, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText("JIJ", pos.current.x, pos.current.y - 45);

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
    ctx.fillStyle = 'rgba(71, 85, 105, 0.8)';
    OBSTACLES.forEach(o => {
      ctx.fillRect(mmX + o.x * mmScale, mmY + o.y * mmScale, o.w * mmScale, o.h * mmScale);
    });
    Object.entries(lobbyData?.players || {}).forEach(([id, p]) => {
      if (!p.alive || !user) return;
      ctx.fillStyle = id === user.uid ? '#3b82f6' : '#ef4444';
      ctx.beginPath();
      ctx.arc(mmX + p.x * mmScale, mmY + p.y * mmScale, 3, 0, Math.PI * 2);
      ctx.fill();
    });
    
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText("SPACE = Shoot | SHIFT = Dash", 20, screenSize.h - 20);
  };

  const sync = () => {
    if (!user || !lobbyCode) return;
    const ref = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    updateDoc(ref, {
      [`players.${user.uid}.x`]: pos.current.x,
      [`players.${user.uid}.y`]: pos.current.y,
    }).catch(()=>{});
  };

  const shoot = (tx, ty) => {
    if (!user) return;
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
    updateDoc(ref, { bullets: [...active.slice(-20), b] });
  };

  const die = async (killerId) => {
    if (!user) return;
    setGameState('DEAD');
    const ref = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    const updates = { [`players.${user.uid}.alive`]: false };
    if (killerId && lobbyData.players[killerId]) {
        const newScore = (lobbyData.players[killerId].score || 0) + 1;
        updates[`players.${killerId}.score`] = newScore;
        if (newScore >= WIN_SCORE) updates.winner = lobbyData.players[killerId].name;
    }
    await updateDoc(ref, updates);
  };

  const join = async () => {
    if (!playerName || !lobbyCode || !user) return;
    const startPos = findSafeSpawn();
    const ref = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await setDoc(ref, {
      status: 'WAITING',
      bullets: [],
      winner: null,
      players: { [user.uid]: { name: playerName, alive: true, x: startPos.x, y: startPos.y, score: 0 } }
    }, { merge: true });
    setGameState('LOBBY');
  };

  const start = async () => {
    const ref = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    const updates = { status: 'PLAYING', bullets: [], winner: null };
    Object.keys(lobbyData.players).forEach(uid => {
        const s = findSafeSpawn();
        updates[`players.${uid}.alive`] = true;
        updates[`players.${uid}.x`] = s.x;
        updates[`players.${uid}.y`] = s.y;
        updates[`players.${uid}.score`] = 0;
    });
    await updateDoc(ref, updates);
  };

  const handleKeyDown = (e) => keysPressed.current[e.key] = true;
  const handleKeyUp = (e) => keysPressed.current[e.key] = false;

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  if (loading) return (
    <div className="w-full h-screen bg-slate-950 flex items-center justify-center text-white">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-emerald-500"></div>
    </div>
  );

  if (gameState === 'MENU') return (
    <div className="w-full h-screen bg-slate-950 flex items-center justify-center text-white font-sans overflow-hidden">
      <div className="bg-slate-900 p-12 rounded-[3rem] shadow-2xl w-full max-w-sm border-b-8 border-emerald-500/20 text-center">
        <Crosshair size={60} className="text-emerald-400 mx-auto mb-6 animate-pulse" />
        <h1 className="text-5xl font-black mb-10 italic">BOOM.IO</h1>
        <input className="w-full bg-slate-800 p-4 rounded-2xl mb-4 border border-slate-700 outline-none focus:border-emerald-500 text-white" placeholder="JOUW NAAM" value={playerName} onChange={e => setPlayerName(e.target.value)} />
        <input className="w-full bg-slate-800 p-4 rounded-2xl mb-8 border border-slate-700 outline-none focus:border-emerald-500 uppercase text-white" placeholder="LOBBY CODE" value={lobbyCode} onChange={e => setLobbyCode(e.target.value)} />
        <button onClick={join} disabled={!user} className="w-full bg-emerald-500 py-5 rounded-2xl font-black text-xl hover:bg-emerald-400 text-slate-900 shadow-[0_6px_0_rgb(16,185,129)] active:translate-y-1 transition-all uppercase disabled:opacity-50">Speel Nu</button>
      </div>
    </div>
  );

  if (gameState === 'LOBBY') return (
    <div className="w-full h-screen bg-slate-950 flex items-center justify-center text-white font-sans overflow-hidden">
      <div className="bg-slate-900 p-10 rounded-[2.5rem] w-full max-w-md text-center border-b-8 border-blue-500/20">
        <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold text-slate-400 uppercase">Lobby: {lobbyCode}</h2>
            <div className="bg-emerald-500/10 text-emerald-400 px-3 py-1 rounded-full text-xs font-bold">First to {WIN_SCORE}</div>
        </div>
        <div className="space-y-3 mb-10 max-h-60 overflow-y-auto">
          {Object.values(lobbyData?.players || {}).map((p, i) => (
            <div key={i} className="bg-slate-800 p-4 rounded-2xl border border-slate-700 flex justify-between font-bold items-center">
              <span className="flex items-center gap-2"><div className="w-2 h-2 bg-blue-500 rounded-full"/> {p.name}</span>
              <span className="text-slate-500 text-sm">SPELER</span>
            </div>
          ))}
        </div>
        <button onClick={start} className="w-full bg-blue-500 py-5 rounded-2xl font-black shadow-[0_6px_0_rgb(59,130,246)] uppercase flex items-center justify-center gap-2 text-white hover:bg-blue-400 transition-colors"><Play size={20}/> Start Match</button>
      </div>
    </div>
  );

  if (gameState === 'WINNER') return (
    <div className="fixed inset-0 bg-slate-950 flex items-center justify-center z-[200] text-white">
        <div className="text-center animate-bounce">
            <Trophy size={100} className="text-yellow-400 mx-auto mb-6" />
            <h1 className="text-6xl font-black mb-4 uppercase text-yellow-400">Winnaar!</h1>
            <p className="text-4xl font-bold mb-10">{lobbyData?.winner}</p>
            <button onClick={() => window.location.reload()} className="bg-white text-slate-900 px-8 py-4 rounded-full font-bold uppercase hover:bg-emerald-400">Terug naar Menu</button>
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
      />
      <div className="absolute top-4 left-4 bg-black/40 p-4 rounded-xl backdrop-blur-sm border border-white/10 text-white pointer-events-none select-none">
         <h3 className="font-bold text-xs uppercase text-slate-400 mb-2 italic">Scorebord</h3>
         {Object.values(lobbyData?.players || {})
            .sort((a,b) => b.score - a.score)
            .map((p, i) => (
             <div key={i} className="flex justify-between w-40 text-sm mb-1">
                 <span className={p.name === playerName ? "text-blue-400 font-bold" : "text-white"}>{i+1}. {p.name}</span>
                 <span className="font-mono text-yellow-400 font-bold">{p.score || 0}</span>
             </div>
         ))}
      </div>

      {gameState === 'DEAD' && (
        <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-[100] text-white">
          <div className="text-center">
            <Skull size={80} className="text-rose-500 mx-auto mb-6 animate-pulse" />
            <h2 className="text-5xl font-black mb-4 uppercase italic">Geëlimineerd</h2>
            <p className="text-xl text-slate-400 mb-8">Respawn in <span className="text-white font-mono text-3xl font-bold">{deathTimer}</span></p>
            <div className="w-64 h-2 bg-slate-800 rounded-full mx-auto overflow-hidden">
                <div className="h-full bg-emerald-500 transition-all duration-1000 ease-linear" style={{ width: `${(deathTimer/5)*100}%` }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}