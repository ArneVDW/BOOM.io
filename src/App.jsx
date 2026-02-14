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
import { Skull, RotateCcw, Crosshair, Users, Play } from 'lucide-react';

// --- CONFIGURATIE ---
const FIREBASE_CONFIG = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
  apiKey: "AIzaSyDw-WSx1oYTHzadXUB7csmKNhZlO0RTw6Y",
  authDomain: "multiplayer-shooter-c0b9f.firebaseapp.com",
  projectId: "multiplayer-shooter-c0b9f",
  storageBucket: "multiplayer-shooter-c0b9f.firebasestorage.app",
  messagingSenderId: "773037810608",
  appId: "1:773037810608:web:f8b22fc68fa1e0c34f2c75"
};

const APP_ID = typeof __app_id !== 'undefined' ? __app_id : 'boom-io-v4-final';
const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

// Game Constanten
const ACCELERATION = 0.8;
const FRICTION = 0.90;
const MAX_SPEED = 9;
const BULLET_SPEED = 20;
const RELOAD_TIME = 200; 
const MAP_WIDTH = 2400;  // Extra grote map
const MAP_HEIGHT = 1800; 
const VIEWPORT_W = 800;
const VIEWPORT_H = 600;
const BULLET_LIFESPAN = 1200; 

// Uitgebreide Obstakels (Arena stijl)
const OBSTACLES = [
  // Buitenmuren (onzichtbaar in logica, maar zichtbaar in render) zijn de limieten
  // Midden obstakels
  { x: 1000, y: 700, w: 400, h: 400 }, // Het grote blok in het midden
  { x: 400, y: 400, w: 200, h: 50 },
  { x: 1800, y: 400, w: 200, h: 50 },
  { x: 400, y: 1350, w: 200, h: 50 },
  { x: 1800, y: 1350, w: 200, h: 50 },
  // Verticale dekking
  { x: 200, y: 600, w: 50, h: 600 },
  { x: 2150, y: 600, w: 50, h: 600 },
  // Verspreide blokjes
  { x: 700, y: 300, w: 100, h: 100 },
  { x: 1600, y: 300, w: 100, h: 100 },
  { x: 700, y: 1400, w: 100, h: 100 },
  { x: 1600, y: 1400, w: 100, h: 100 },
];

// Helper: Check botsing tussen punt en rechthoek (met marge)
function isPointInRect(x, y, rect, margin = 0) {
  return x >= rect.x - margin && x <= rect.x + rect.w + margin && 
         y >= rect.y - margin && y <= rect.y + rect.h + margin;
}

// Helper: Zoek een veilige spawnplek (CRUCIAAL)
function findSafeSpawn() {
  let safe = false;
  let spawn = { x: 1200, y: 900 }; // Default center
  let attempts = 0;

  while (!safe && attempts < 100) {
    // Genereer random punt binnen de map (met buffer van 100px aan randen)
    const tx = Math.random() * (MAP_WIDTH - 200) + 100;
    const ty = Math.random() * (MAP_HEIGHT - 200) + 100;
    
    let collision = false;
    for (let obs of OBSTACLES) {
      // Check of punt in obstakel zit (met 60px marge voor speler grootte)
      if (isPointInRect(tx, ty, obs, 60)) {
        collision = true;
        break;
      }
    }
    
    if (!collision) {
      spawn = { x: tx, y: ty };
      safe = true;
    }
    attempts++;
  }
  return spawn;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [gameState, setGameState] = useState('MENU'); 
  const [lobbyCode, setLobbyCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [lobbyData, setLobbyData] = useState(null);

  const canvasRef = useRef(null);
  // Initialiseer op veilige plek, maar wordt overschreven bij start
  const pos = useRef({ x: 1200, y: 900 }); 
  const vel = useRef({ x: 0, y: 0 });
  const mousePosRaw = useRef({ x: 0, y: 0 });
  const keysPressed = useRef({});
  const isMouseDown = useRef(false);
  const lastShotTime = useRef(0);
  const lastUpdateToDb = useRef(0);
  const frameRef = useRef();

  // 1. Auth
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

  // 2. Lobby Sync
  useEffect(() => {
    if (!user || !lobbyCode || gameState === 'MENU') return;
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    return onSnapshot(lobbyRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setLobbyData(data);
        if (data.status === 'PLAYING' && gameState === 'LOBBY') {
           // Als het spel start, pakken we de positie uit de DB of zoeken we een nieuwe veilige plek
           const myStart = data.players?.[user.uid] || findSafeSpawn();
           pos.current = { x: myStart.x, y: myStart.y };
           setGameState('PLAYING');
        }
        if (gameState === 'PLAYING' && data.players?.[user.uid]?.alive === false) {
           setGameState('DEAD');
        }
      }
    });
  }, [user, lobbyCode, gameState]);

  // 3. Game Loop
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

    // A. Beweging & Frictie
    const dx = worldMouseX - pos.current.x;
    const dy = worldMouseY - pos.current.y;
    const dist = Math.sqrt(dx*dx + dy*dy);

    if (dist > 10) {
      vel.current.x += (dx / dist) * ACCELERATION;
      vel.current.y += (dy / dist) * ACCELERATION;
    }

    vel.current.x *= FRICTION;
    vel.current.y *= FRICTION;

    // Snelheidslimiet
    const speed = Math.sqrt(vel.current.x**2 + vel.current.y**2);
    if (speed > MAX_SPEED) {
        vel.current.x = (vel.current.x / speed) * MAX_SPEED;
        vel.current.y = (vel.current.y / speed) * MAX_SPEED;
    }

    // B. Collision Detection (Sliding)
    let nextX = pos.current.x + vel.current.x;
    let nextY = pos.current.y + vel.current.y;
    const r = 20; // Speler radius

    // Check Map Grenzen
    if (nextX < r) nextX = r;
    if (nextX > MAP_WIDTH - r) nextX = MAP_WIDTH - r;
    if (nextY < r) nextY = r;
    if (nextY > MAP_HEIGHT - r) nextY = MAP_HEIGHT - r;

    // Check Obstakels (X as)
    let hitX = false;
    for (let obs of OBSTACLES) {
      if (nextX + r > obs.x && nextX - r < obs.x + obs.w && pos.current.y + r > obs.y && pos.current.y - r < obs.y + obs.h) hitX = true;
    }
    if (!hitX) pos.current.x = nextX; else vel.current.x *= 0.5; // Bounce/Slide

    // Check Obstakels (Y as)
    let hitY = false;
    for (let obs of OBSTACLES) {
      if (pos.current.x + r > obs.x && pos.current.x - r < obs.x + obs.w && nextY + r > obs.y && nextY - r < obs.y + obs.h) hitY = true;
    }
    if (!hitY) pos.current.y = nextY; else vel.current.y *= 0.5;

    // C. Schieten
    if ((keysPressed.current[' '] || isMouseDown.current) && Date.now() - lastShotTime.current > RELOAD_TIME) {
      shoot(worldMouseX, worldMouseY);
    }

    // D. Hit Detection (Lokaal)
    if (lobbyData?.bullets) {
      const now = Date.now();
      lobbyData.bullets.forEach(b => {
        if (b.ownerId !== user.uid) {
          const age = (now - b.createdAt) / 1000;
          const bx = b.x + b.vx * age * 60;
          const by = b.y + b.vy * age * 60;
          const d = Math.sqrt((bx - pos.current.x)**2 + (by - pos.current.y)**2);
          if (d < 25) die(); // 25px hit radius
        }
      });
    }

    // E. Sync naar DB (Throttled ~20fps)
    if (Date.now() - lastUpdateToDb.current > 50) {
      sync();
      lastUpdateToDb.current = Date.now();
    }
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Camera positie
    const camX = pos.current.x - VIEWPORT_W / 2;
    const camY = pos.current.y - VIEWPORT_H / 2;

    // 1. Achtergrond wissen
    ctx.fillStyle = '#0f172a'; // Slate-900
    ctx.fillRect(0, 0, VIEWPORT_W, VIEWPORT_H);

    ctx.save();
    ctx.translate(-camX, -camY); // Wereld verplaatsen

    // 2. Grid Tekenen (Mooier raster)
    ctx.strokeStyle = '#1e293b'; // Slate-800
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= MAP_WIDTH; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, MAP_HEIGHT); }
    for (let y = 0; y <= MAP_HEIGHT; y += 100) { ctx.moveTo(0, y); ctx.lineTo(MAP_WIDTH, y); }
    ctx.stroke();

    // 3. Obstakels
    ctx.fillStyle = '#334155'; // Slate-700
    ctx.strokeStyle = '#64748b'; // Slate-500
    ctx.lineWidth = 4;
    OBSTACLES.forEach(o => {
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeRect(o.x, o.y, o.w, o.h);
      // Detail: kruis in midden van obstakel voor 'texture' gevoel
      ctx.beginPath();
      ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + o.w, o.y + o.h);
      ctx.stroke();
    });

    // 4. Kogels
    const now = Date.now();
    ctx.fillStyle = '#fbbf24'; // Amber-400
    ctx.shadowBlur = 15;
    ctx.shadowColor = '#fbbf24';
    lobbyData?.bullets?.forEach(b => {
      const age = (now - b.createdAt) / 1000;
      if (age < BULLET_LIFESPAN / 1000) {
        const bx = b.x + b.vx * age * 60;
        const by = b.y + b.vy * age * 60;
        
        // Simpele occlusion check (teken niet als het achter een muur zit voor performance? Nee, te duur)
        ctx.beginPath();
        ctx.arc(bx, by, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.shadowBlur = 0;

    // 5. Andere Spelers
    Object.entries(lobbyData?.players || {}).forEach(([id, p]) => {
      if (id === user.uid || !p.alive) return;
      
      // Cirkel body
      ctx.fillStyle = '#ef4444'; // Red-500
      ctx.strokeStyle = '#991b1b'; // Red-800
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Naam boven hoofd
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(p.name, p.x, p.y - 30);
    });

    // 6. Jijzelf (Blauw)
    ctx.fillStyle = '#3b82f6'; // Blue-500
    ctx.strokeStyle = '#1e40af'; // Blue-800
    ctx.lineWidth = 3;
    ctx.shadowBlur = 20;
    ctx.shadowColor = 'rgba(59, 130, 246, 0.5)';
    ctx.beginPath();
    ctx.arc(pos.current.x, pos.current.y, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
    
    // Naam en indicator boven jezelf
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText("JIJ", pos.current.x, pos.current.y - 30);

    ctx.restore(); // Einde wereld transformatie

    // 7. UI Overlay: Minimap (Rechtsboven)
    // Map size: 2400x1800. Minimap size: 240x180. Scale: 0.1
    const mmScale = 0.1;
    const mmW = MAP_WIDTH * mmScale;
    const mmH = MAP_HEIGHT * mmScale;
    const mmX = VIEWPORT_W - mmW - 20;
    const mmY = 20;

    // Minimap Achtergrond
    ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 2;
    ctx.fillRect(mmX, mmY, mmW, mmH);
    ctx.strokeRect(mmX, mmY, mmW, mmH);

    // Minimap Obstakels
    ctx.fillStyle = 'rgba(71, 85, 105, 0.8)';
    OBSTACLES.forEach(o => {
      ctx.fillRect(mmX + o.x * mmScale, mmY + o.y * mmScale, o.w * mmScale, o.h * mmScale);
    });

    // Minimap Spelers
    Object.entries(lobbyData?.players || {}).forEach(([id, p]) => {
      if (!p.alive) return;
      ctx.fillStyle = id === user.uid ? '#3b82f6' : '#ef4444';
      ctx.beginPath();
      ctx.arc(mmX + p.x * mmScale, mmY + p.y * mmScale, 3, 0, Math.PI * 2);
      ctx.fill();
    });

    // 8. Crosshair (Muis)
    const mx = mousePosRaw.current.x;
    const my = mousePosRaw.current.y;
    ctx.strokeStyle = '#10b981'; // Emerald-500
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mx, my, 8, 0, Math.PI*2);
    ctx.moveTo(mx - 12, my); ctx.lineTo(mx + 12, my);
    ctx.moveTo(mx, my - 12); ctx.lineTo(mx, my + 12);
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
    updateDoc(ref, { bullets: [...active.slice(-20), b] });
  };

  const die = () => {
    setGameState('DEAD');
    const ref = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    updateDoc(ref, { [`players.${user.uid}.alive`]: false });
  };

  const join = async () => {
    if (!playerName || !lobbyCode) return;
    const startPos = findSafeSpawn();
    const ref = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await setDoc(ref, {
      status: 'WAITING',
      bullets: [],
      players: { [user.uid]: { name: playerName, alive: true, x: startPos.x, y: startPos.y } }
    }, { merge: true });
    setGameState('LOBBY');
  };

  const start = async () => {
    const ref = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    // Reset alle spelers naar een veilige spawn
    const updates = {};
    if (lobbyData?.players) {
        Object.keys(lobbyData.players).forEach(uid => {
            const s = findSafeSpawn();
            updates[`players.${uid}.alive`] = true;
            updates[`players.${uid}.x`] = s.x;
            updates[`players.${uid}.y`] = s.y;
        });
    }
    updates.status = 'PLAYING';
    updates.bullets = [];
    await updateDoc(ref, updates);
  };

  // --- UI RENDER ---

  if (gameState === 'MENU') return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6 text-white font-sans">
      <div className="bg-slate-900 p-12 rounded-[3rem] shadow-2xl w-full max-w-sm border-b-8 border-emerald-500/20 text-center">
        <Crosshair size={60} className="text-emerald-400 mx-auto mb-6 animate-pulse" />
        <h1 className="text-5xl font-black mb-10 tracking-tighter italic">BOOM.IO</h1>
        <input className="w-full bg-slate-800 p-4 rounded-2xl mb-4 border border-slate-700 outline-none focus:border-emerald-500 text-white" placeholder="NAAM" value={playerName} onChange={e => setPlayerName(e.target.value)} />
        <input className="w-full bg-slate-800 p-4 rounded-2xl mb-8 border border-slate-700 outline-none focus:border-emerald-500 uppercase text-white" placeholder="CODE" value={lobbyCode} onChange={e => setLobbyCode(e.target.value)} />
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
        <button onClick={start} className="w-full bg-blue-500 py-5 rounded-2xl font-black shadow-[0_6px_0_rgb(59,130,246)] uppercase flex items-center justify-center gap-2"><Play size={20}/> Start Match</button>
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