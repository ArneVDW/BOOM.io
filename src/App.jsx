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
import { Shield, Skull, RotateCcw, Crosshair } from 'lucide-react';

// --- CONFIGURATIE ---
const FIREBASE_CONFIG = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
  apiKey: "AIzaSyDw-WSx1oYTHzadXUB7csmKNhZlO0RTw6Y",
  authDomain: "multiplayer-shooter-c0b9f.firebaseapp.com",
  projectId: "multiplayer-shooter-c0b9f",
  storageBucket: "multiplayer-shooter-c0b9f.firebasestorage.app",
  messagingSenderId: "773037810608",
  appId: "1:773037810608:web:f8b22fc68fa1e0c34f2c75"
};

const APP_ID = typeof __app_id !== 'undefined' ? __app_id : 'mijn-shooter-game-v2';

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

// Game Instellingen
const ACCELERATION = 0.6;
const FRICTION = 0.92;
const MAX_SPEED = 7;
const BULLET_SPEED = 15;
const RELOAD_TIME = 300; 
const MAP_WIDTH = 1600;  
const MAP_HEIGHT = 1200; 
const VIEWPORT_W = 800;
const VIEWPORT_H = 600;
const BULLET_LIFESPAN = 1200; 

const OBSTACLES = [
  { x: 750, y: 550, w: 100, h: 100 },
  { x: 300, y: 200, w: 400, h: 40 },
  { x: 900, y: 200, w: 400, h: 40 },
  { x: 400, y: 500, w: 60, h: 60 },
  { x: 1140, y: 500, w: 60, h: 60 },
  { x: 400, y: 700, w: 60, h: 60 },
  { x: 1140, y: 700, w: 60, h: 60 },
  { x: 300, y: 1000, w: 1000, h: 40 },
  { x: 100, y: 300, w: 40, h: 600 },
  { x: 1460, y: 300, w: 40, h: 600 },
  { x: 200, y: 150, w: 40, h: 40 },
  { x: 1360, y: 150, w: 40, h: 40 },
];

function isPointInRect(x, y, rect, margin = 0) {
  return x >= rect.x - margin && x <= rect.x + rect.w + margin && 
         y >= rect.y - margin && y <= rect.y + rect.h + margin;
}

const findSafeSpawn = () => {
  let safe = false;
  let spawn = { x: 800, y: 600 };
  let attempts = 0;
  while (!safe && attempts < 50) {
    spawn = { x: Math.random() * (MAP_WIDTH - 200) + 100, y: Math.random() * (MAP_HEIGHT - 200) + 100 };
    let inObstacle = false;
    for (let obs of OBSTACLES) {
      if (isPointInRect(spawn.x, spawn.y, obs, 45)) { inObstacle = true; break; }
    }
    if (!inObstacle) safe = true;
    attempts++;
  }
  return spawn;
};

export default function App() {
  const [user, setUser] = useState(null);
  const [gameState, setGameState] = useState('MENU'); 
  const [lobbyCode, setLobbyCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [lobbyData, setLobbyData] = useState(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0); // Gebruikt om React te forceren om te her-renderen

  // Refs voor high-performance updates
  const pos = useRef({ x: 800, y: 600 });
  const vel = useRef({ x: 0, y: 0 });
  const mousePosRaw = useRef({ x: 0, y: 0 });
  const lastShotTime = useRef(0);
  const keysPressed = useRef({});
  const isMouseDown = useRef(false);
  const gameLoopRef = useRef(null);
  const lastUpdateToDb = useRef(0);

  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (err) { console.error("Auth error:", err); }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user || !lobbyCode || gameState === 'MENU') return;
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    const unsub = onSnapshot(lobbyRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setLobbyData(data);
        if (data.status === 'PLAYING' && gameState === 'LOBBY') {
          setGameState('PLAYING');
          const myStartPos = data.players?.[user.uid] || findSafeSpawn();
          pos.current = { x: myStartPos.x, y: myStartPos.y };
        }
        if (gameState === 'PLAYING' && data.players?.[user.uid]?.alive === false) {
          setGameState('DEAD');
        }
      }
    });
    return () => unsub();
  }, [user, lobbyCode, gameState]);

  useEffect(() => {
    if (gameState === 'PLAYING') {
      gameLoopRef.current = requestAnimationFrame(gameLoop);
    }
    return () => { if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current); };
  }, [gameState]);

  const gameLoop = () => {
    // 1. Lokale input berekening
    const cameraX = pos.current.x - VIEWPORT_W / 2;
    const cameraY = pos.current.y - VIEWPORT_H / 2;
    const worldMouseX = mousePosRaw.current.x + cameraX;
    const worldMouseY = mousePosRaw.current.y + cameraY;

    // Beweging logica (Local Prediction)
    const dx = worldMouseX - pos.current.x;
    const dy = worldMouseY - pos.current.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > 15) {
      vel.current.x += (dx / dist) * ACCELERATION;
      vel.current.y += (dy / dist) * ACCELERATION;
    }

    vel.current.x *= FRICTION;
    vel.current.y *= FRICTION;

    const currentSpeed = Math.sqrt(vel.current.x**2 + vel.current.y**2);
    if (currentSpeed > MAX_SPEED) {
      vel.current.x = (vel.current.x / currentSpeed) * MAX_SPEED;
      vel.current.y = (vel.current.y / currentSpeed) * MAX_SPEED;
    }

    // Collision (Local)
    let nextX = pos.current.x + vel.current.x;
    let nextY = pos.current.y + vel.current.y;
    const r = 18; 

    let collX = false;
    for (let obs of OBSTACLES) {
      if (nextX + r > obs.x && nextX - r < obs.x + obs.w && 
          pos.current.y + r > obs.y && pos.current.y - r < obs.y + obs.h) {
        collX = true; break;
      }
    }
    if (!collX && nextX > r && nextX < MAP_WIDTH - r) pos.current.x = nextX;
    else vel.current.x = 0;

    let collY = false;
    for (let obs of OBSTACLES) {
      if (pos.current.x + r > obs.x && pos.current.x - r < obs.x + obs.w && 
          nextY + r > obs.y && nextY - r < obs.y + obs.h) {
        collY = true; break;
      }
    }
    if (!collY && nextY > r && nextY < MAP_HEIGHT - r) pos.current.y = nextY;
    else vel.current.y = 0;

    // 2. Schieten
    if ((keysPressed.current[' '] || isMouseDown.current) && Date.now() - lastShotTime.current > RELOAD_TIME) {
      fireBullet(worldMouseX, worldMouseY);
    }

    // 3. Hit Detection (Local)
    if (lobbyData?.bullets) {
      const now = Date.now();
      for (const bullet of lobbyData.bullets) {
        if (bullet.ownerId !== user.uid && (now - bullet.createdAt < BULLET_LIFESPAN)) {
          const age = (now - bullet.createdAt) / 1000;
          const bx = bullet.x + (bullet.vx * age * 60);
          const by = bullet.y + (bullet.vy * age * 60);
          
          let hitMuur = false;
          for(let o of OBSTACLES) { if (isPointInRect(bx, by, o)) hitMuur = true; }
          
          if (!hitMuur) {
            const d = Math.sqrt((bx - pos.current.x)**2 + (by - pos.current.y)**2);
            if (d < 22) handleDeath();
          }
        }
      }
    }

    // 4. Sync naar DB (Throttled)
    const now = Date.now();
    if (now - lastUpdateToDb.current > 45) { // ~22 updates per seconde
      syncPos();
      lastUpdateToDb.current = now;
    }

    // Forceer React Render
    setTick(t => t + 1);
    gameLoopRef.current = requestAnimationFrame(gameLoop);
  };

  const syncPos = async () => {
    if (!user || !lobbyCode) return;
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    updateDoc(lobbyRef, {
      [`players.${user.uid}.x`]: pos.current.x,
      [`players.${user.uid}.y`]: pos.current.y,
    }).catch(() => {}); // Stil falen bij netwerk lag
  };

  const fireBullet = async (targetX, targetY) => {
    lastShotTime.current = Date.now();
    const dx = targetX - pos.current.x;
    const dy = targetY - pos.current.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    
    const bullet = {
      id: Math.random().toString(36).substring(7),
      ownerId: user.uid,
      x: pos.current.x,
      y: pos.current.y,
      vx: (dx/dist) * BULLET_SPEED,
      vy: (dy/dist) * BULLET_SPEED,
      createdAt: Date.now()
    };

    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    const now = Date.now();
    const activeBullets = (lobbyData?.bullets || []).filter(b => now - b.createdAt < BULLET_LIFESPAN);
    
    updateDoc(lobbyRef, { 
      bullets: [...activeBullets.slice(-15), bullet] // Max 15 kogels tegelijk voor snelheid
    });
  };

  const handleDeath = async () => {
    if (gameState !== 'PLAYING') return;
    setGameState('DEAD');
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    updateDoc(lobbyRef, { [`players.${user.uid}.alive`]: false });
  };

  useEffect(() => {
    const handleKeyDown = (e) => { keysPressed.current[e.key] = true; };
    const handleKeyUp = (e) => { keysPressed.current[e.key] = false; };
    const handleMouseDown = (e) => { if(e.button === 0) isMouseDown.current = true; };
    const handleMouseUp = () => { isMouseDown.current = false; };
    const handleMouseMove = (e) => {
      const area = document.getElementById('game-viewport');
      if (area) {
        const rect = area.getBoundingClientRect();
        mousePosRaw.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  const joinLobby = async () => {
    if (!playerName || !lobbyCode) return setError("Naam en code verplicht!");
    const startPos = findSafeSpawn();
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await setDoc(lobbyRef, {
      status: 'WAITING',
      bullets: [],
      players: { [user.uid]: { name: playerName, alive: true, x: startPos.x, y: startPos.y } }
    }, { merge: true });
    setGameState('LOBBY');
  };

  const startSpel = async () => {
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    const newPlayers = { ...lobbyData.players };
    Object.keys(newPlayers).forEach(id => {
        const safe = findSafeSpawn();
        newPlayers[id].alive = true;
        newPlayers[id].x = safe.x;
        newPlayers[id].y = safe.y;
    });
    await updateDoc(lobbyRef, { status: 'PLAYING', bullets: [], players: newPlayers });
  };

  const getLaserEnd = () => {
    const cameraX = pos.current.x - VIEWPORT_W / 2;
    const cameraY = pos.current.y - VIEWPORT_H / 2;
    const worldMouseX = mousePosRaw.current.x + cameraX;
    const worldMouseY = mousePosRaw.current.y + cameraY;
    const dx = worldMouseX - pos.current.x;
    const dy = worldMouseY - pos.current.y;
    const angle = Math.atan2(dy, dx);
    let currX = pos.current.x;
    let currY = pos.current.y;
    for (let i = 0; i < 400; i += 8) {
      currX += Math.cos(angle) * 8;
      currY += Math.sin(angle) * 8;
      for (let obs of OBSTACLES) { if (isPointInRect(currX, currY, obs)) return { x: currX, y: currY }; }
      if (currX < 0 || currX > MAP_WIDTH || currY < 0 || currY > MAP_HEIGHT) return { x: currX, y: currY };
    }
    return { x: currX, y: currY };
  };

  if (gameState === 'MENU') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-950 text-white font-sans">
        <div className="bg-slate-900 p-12 rounded-[3rem] shadow-2xl border-b-8 border-emerald-500/20 text-center w-full max-w-sm">
          <Crosshair size={48} className="text-emerald-400 mx-auto mb-6" />
          <h1 className="text-5xl font-black mb-8 italic text-emerald-400">BOOM.IO</h1>
          <input className="w-full bg-slate-800 p-4 rounded-2xl mb-4 border border-slate-700 outline-none focus:border-emerald-500" placeholder="JOUW NAAM" value={playerName} onChange={e => setPlayerName(e.target.value)} />
          <input className="w-full bg-slate-800 p-4 rounded-2xl mb-8 border border-slate-700 outline-none focus:border-emerald-500 uppercase" placeholder="LOBBY CODE" value={lobbyCode} onChange={e => setLobbyCode(e.target.value)} />
          <button onClick={joinLobby} className="w-full bg-emerald-500 py-4 rounded-2xl font-black text-xl hover:bg-emerald-400 shadow-[0_6px_0_rgb(16,185,129)] active:translate-y-1 transition-all text-slate-900 uppercase">Speel Nu</button>
        </div>
      </div>
    );
  }

  if (gameState === 'LOBBY') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-950 text-white">
        <div className="bg-slate-900 p-10 rounded-[2.5rem] w-full max-w-sm text-center">
          <h2 className="text-2xl font-bold mb-6 text-slate-400">LOBBY: {lobbyCode}</h2>
          <div className="space-y-2 mb-8 text-left">
            {Object.values(lobbyData?.players || {}).map((p, i) => (
              <div key={i} className="bg-slate-800 p-3 rounded-xl border border-slate-700 flex justify-between">
                <span>{p.name}</span>
                <span className="text-emerald-400 text-xs font-bold uppercase">Ready</span>
              </div>
            ))}
          </div>
          <button onClick={startSpel} className="w-full bg-blue-500 py-4 rounded-xl font-bold shadow-[0_4px_0_rgb(59,130,246)] uppercase">Start Match</button>
        </div>
      </div>
    );
  }

  const cameraX = pos.current.x - VIEWPORT_W / 2;
  const cameraY = pos.current.y - VIEWPORT_H / 2;
  const laser = getLaserEnd();

  return (
    <div className="fixed inset-0 bg-slate-950 flex flex-col items-center justify-center overflow-hidden cursor-none p-4 select-none">
      <div id="game-viewport" className="relative bg-slate-900 border-8 border-slate-800 rounded-2xl shadow-2xl overflow-hidden" style={{ width: VIEWPORT_W, height: VIEWPORT_H }}>
        
        {/* De Wereld */}
        <div className="absolute" style={{ transform: `translate(${-cameraX}px, ${-cameraY}px)` }}>
          
          {/* Grid Background */}
          <div className="absolute inset-0 opacity-10" style={{ 
            backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', 
            backgroundSize: '50px 50px', 
            width: MAP_WIDTH, height: MAP_HEIGHT 
          }} />

          {/* Muren */}
          {OBSTACLES.map((o, i) => (
            <div key={i} className="absolute bg-slate-800 border-2 border-slate-700 shadow-xl rounded-lg" 
              style={{ left: o.x, top: o.y, width: o.w, height: o.h }} />
          ))}

          {/* Laser Sight */}
          <svg className="absolute inset-0 pointer-events-none z-10" style={{ width: MAP_WIDTH, height: MAP_HEIGHT }}>
              <line x1={pos.current.x} y1={pos.current.y} x2={laser.x} y2={laser.y} stroke="rgba(255, 50, 50, 0.4)" strokeWidth="2" strokeDasharray="5,5" />
          </svg>

          {/* Andere Spelers (Interpoleer uit lobbyData) */}
          {lobbyData?.players && Object.entries(lobbyData.players).map(([id, p]) => {
            if (!p.alive || id === user?.uid) return null;
            return (
              <div key={id} className="absolute z-20 transition-all duration-100 ease-linear" style={{ left: p.x - 20, top: p.y - 20, width: 40, height: 40 }}>
                <div className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap bg-black/50 px-2 py-0.5 rounded text-[10px] uppercase font-bold">{p.name}</div>
                <div className="w-full h-full bg-rose-600 border-4 border-rose-400 rounded-xl shadow-lg flex items-center justify-center">
                  <Shield size={18} className="text-white/20" />
                </div>
              </div>
            );
          })}

          {/* Jijzelf (Directe input, geen lag) */}
          <div className="absolute z-30" style={{ left: pos.current.x - 20, top: pos.current.y - 20, width: 40, height: 40 }}>
            <div className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap bg-emerald-500 px-2 py-0.5 rounded text-[10px] uppercase font-bold text-slate-900">Jij</div>
            <div className="w-full h-full bg-blue-600 border-4 border-blue-400 rounded-xl shadow-xl flex items-center justify-center ring-4 ring-blue-500/20">
              <Shield size={18} className="text-white/40" />
            </div>
          </div>

          {/* Kogels */}
          {lobbyData?.bullets?.map(b => {
            const age = (Date.now() - b.createdAt) / 1000;
            if (Date.now() - b.createdAt > BULLET_LIFESPAN) return null;
            const curX = b.x + (b.vx * age * 60);
            const curY = b.y + (b.vy * age * 60);
            for(let o of OBSTACLES) { if (isPointInRect(curX, curY, o)) return null; }
            return (
              <div key={b.id} className="absolute bg-white rounded-full w-3 h-3 z-40 shadow-[0_0_12px_#fff]" 
                style={{ left: curX - 1.5, top: curY - 1.5 }} />
            );
          })}
        </div>

        {/* Minimap Overlay */}
        <div className="absolute bottom-4 right-4 w-40 h-30 bg-black/60 backdrop-blur-md border-2 border-slate-700 rounded-xl overflow-hidden z-50">
           <div className="relative w-full h-full">
              <div className="absolute w-2 h-2 bg-blue-400 rounded-full" style={{ left: (pos.current.x / MAP_WIDTH) * 100 + '%', top: (pos.current.y / MAP_HEIGHT) * 100 + '%' }} />
              {Object.entries(lobbyData?.players || {}).map(([id, p]) => (
                id !== user?.uid && p.alive && (
                  <div key={id} className="absolute w-1.5 h-1.5 bg-rose-500 rounded-full" style={{ left: (p.x / MAP_WIDTH) * 100 + '%', top: (p.y / MAP_HEIGHT) * 100 + '%' }} />
                )
              ))}
           </div>
        </div>

        {/* Cursor */}
        <div className="absolute z-[100] pointer-events-none" style={{ left: mousePosRaw.current.x - 12, top: mousePosRaw.current.y - 12 }}>
            <div className="w-6 h-6 border-2 border-emerald-400 rounded-full flex items-center justify-center bg-emerald-400/10">
                <div className="w-1 h-1 bg-emerald-400 rounded-full" />
            </div>
        </div>
      </div>

      {/* Death Screen */}
      {gameState === 'DEAD' && (
        <div className="absolute inset-0 bg-slate-950/90 flex items-center justify-center z-[200]">
          <div className="text-center p-12 bg-slate-900 rounded-[3rem] border-b-8 border-rose-600 shadow-2xl max-w-sm w-full">
            <Skull size={64} className="text-rose-500 mx-auto mb-6" />
            <h2 className="text-4xl font-black mb-10 uppercase italic">Uitgeschakeld</h2>
            <button onClick={() => window.location.reload()} className="bg-white text-slate-950 px-8 py-4 rounded-2xl font-black text-lg hover:bg-emerald-400 transition-all flex items-center justify-center gap-3 w-full uppercase"><RotateCcw size={20} /> Probeer Opnieuw</button>
          </div>
        </div>
      )}
    </div>
  );
}