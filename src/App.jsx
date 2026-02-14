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
  updateDoc, 
  arrayUnion
} from 'firebase/firestore';
import { Shield, Play, Skull, RotateCcw, Target } from 'lucide-react';

// --- CONFIGURATIE ---
const FIREBASE_CONFIG = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
  apiKey: "AIzaSyDw-WSx1oYTHzadXUB7csmKNhZlO0RTw6Y",
  authDomain: "multiplayer-shooter-c0b9f.firebaseapp.com",
  projectId: "multiplayer-shooter-c0b9f",
  storageBucket: "multiplayer-shooter-c0b9f.firebasestorage.app",
  messagingSenderId: "773037810608",
  appId: "1:773037810608:web:f8b22fc68fa1e0c34f2c75"
};

const APP_ID = typeof __app_id !== 'undefined' ? __app_id : 'mijn-shooter-game';

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

// Game Instellingen
const PLAYER_SPEED = 4;
const BULLET_SPEED = 10;
const RELOAD_TIME = 500; 
const PLAYER_SIZE = 40;
const MAP_WIDTH = 800;
const MAP_HEIGHT = 600;

const OBSTACLES = [
  { x: 150, y: 150, w: 100, h: 100 },
  { x: 550, y: 100, w: 60, h: 250 },
  { x: 350, y: 400, w: 250, h: 40 },
  { x: 100, y: 400, w: 80, h: 80 },
];

function checkCircleRectCollision(circle, rect) {
  let testX = circle.x;
  let testY = circle.y;
  if (circle.x < rect.x) testX = rect.x;
  else if (circle.x > rect.x + rect.w) testX = rect.x + rect.w;
  if (circle.y < rect.y) testY = rect.y;
  else if (circle.y > rect.y + rect.h) testY = rect.y + rect.h;
  let distX = circle.x - testX;
  let distY = circle.y - testY;
  return Math.sqrt((distX * distX) + (distY * distY)) <= circle.r;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [gameState, setGameState] = useState('MENU'); 
  const [lobbyCode, setLobbyCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [lobbyData, setLobbyData] = useState(null);
  const [error, setError] = useState('');

  const localPos = useRef({ x: 400, y: 300 });
  const mousePos = useRef({ x: 400, y: 300 });
  const lastShotTime = useRef(0);
  const keysPressed = useRef({});
  const isMouseDown = useRef(false);
  const gameLoopRef = useRef(null);
  const lastUpdateToDb = useRef(0);

  useEffect(() => {
    // Forceer Tailwind
    const script = document.createElement('script');
    script.src = "https://cdn.tailwindcss.com";
    document.head.appendChild(script);

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

  // Sync met Firestore
  useEffect(() => {
    if (!user || !lobbyCode || gameState === 'MENU') return;
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    const unsub = onSnapshot(lobbyRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setLobbyData(data);
        if (data.status === 'PLAYING' && gameState === 'LOBBY') {
          setGameState('PLAYING');
        }
        if (gameState === 'PLAYING' && data.players?.[user.uid]?.alive === false) {
          setGameState('DEAD');
        }
      }
    }, (err) => console.error("Firestore error:", err));
    return () => unsub();
  }, [user, lobbyCode, gameState]);

  // Start game loop zodra we op PLAYING staan
  useEffect(() => {
    if (gameState === 'PLAYING') {
      gameLoopRef.current = requestAnimationFrame(gameLoop);
    } else {
      if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current);
    }
    return () => { if (gameLoopRef.current) cancelAnimationFrame(gameLoopRef.current); };
  }, [gameState]);

  const gameLoop = () => {
    // Bewegen naar muis
    const dx = mousePos.current.x - localPos.current.x;
    const dy = mousePos.current.y - localPos.current.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > 10) {
      const moveX = (dx / distance) * PLAYER_SPEED;
      const moveY = (dy / distance) * PLAYER_SPEED;
      let nextX = Math.max(20, Math.min(MAP_WIDTH - 20, localPos.current.x + moveX));
      let nextY = Math.max(20, Math.min(MAP_HEIGHT - 20, localPos.current.y + moveY));

      let hitsObstacle = false;
      for (let obs of OBSTACLES) {
        if (checkCircleRectCollision({ x: nextX, y: nextY, r: PLAYER_SIZE / 2 }, obs)) {
          hitsObstacle = true;
          break;
        }
      }
      if (!hitsObstacle) localPos.current = { x: nextX, y: nextY };
    }

    // Schieten (Spatie of Muisklik)
    if ((keysPressed.current[' '] || isMouseDown.current) && Date.now() - lastShotTime.current > RELOAD_TIME) {
      fireBullet();
    }

    // Bullet collision detectie
    if (lobbyData?.bullets) {
        lobbyData.bullets.forEach(bullet => {
            if (bullet.ownerId !== user.uid) {
                const age = (Date.now() - bullet.createdAt) / 1000;
                const bx = bullet.x + (bullet.vx * age * 60);
                const by = bullet.y + (bullet.vy * age * 60);
                const dist = Math.sqrt(Math.pow(bx - localPos.current.x, 2) + Math.pow(by - localPos.current.y, 2));
                if (dist < (PLAYER_SIZE / 2)) {
                    handleDeath();
                }
            }
        });
    }

    // Update positie naar server (beperkt voor performance)
    const now = Date.now();
    if (now - lastUpdateToDb.current > 40) {
      syncPlayer();
      lastUpdateToDb.current = now;
    }
    gameLoopRef.current = requestAnimationFrame(gameLoop);
  };

  const handleDeath = async () => {
    setGameState('DEAD');
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await updateDoc(lobbyRef, { [`players.${user.uid}.alive`]: false });
  };

  const syncPlayer = async () => {
    if (!user || !lobbyCode) return;
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await updateDoc(lobbyRef, {
      [`players.${user.uid}.x`]: localPos.current.x,
      [`players.${user.uid}.y`]: localPos.current.y,
    });
  };

  const fireBullet = async () => {
    lastShotTime.current = Date.now();
    const dx = mousePos.current.x - localPos.current.x;
    const dy = mousePos.current.y - localPos.current.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    
    const bullet = {
      id: Math.random().toString(36).substring(7),
      ownerId: user.uid,
      x: localPos.current.x,
      y: localPos.current.y,
      vx: (dx/dist) * BULLET_SPEED,
      vy: (dy/dist) * BULLET_SPEED,
      createdAt: Date.now()
    };

    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await updateDoc(lobbyRef, { bullets: arrayUnion(bullet) });
  };

  useEffect(() => {
    const handleKeyDown = (e) => { keysPressed.current[e.key] = true; };
    const handleKeyUp = (e) => { keysPressed.current[e.key] = false; };
    const handleMouseDown = () => { isMouseDown.current = true; };
    const handleMouseUp = () => { isMouseDown.current = false; };
    
    const handleMouseMove = (e) => {
      const area = document.getElementById('game-area');
      if (area) {
        const rect = area.getBoundingClientRect();
        mousePos.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
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
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await setDoc(lobbyRef, {
      status: 'WAITING',
      bullets: [],
      players: { [user.uid]: { name: playerName, alive: true, x: 400, y: 300 } }
    }, { merge: true });
    setGameState('LOBBY');
  };

  const startSpel = async () => {
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    const newPlayers = { ...lobbyData.players };
    Object.keys(newPlayers).forEach(id => {
        newPlayers[id].alive = true;
        newPlayers[id].x = Math.random() * 600 + 100;
        newPlayers[id].y = Math.random() * 400 + 100;
    });
    await updateDoc(lobbyRef, { status: 'PLAYING', bullets: [], players: newPlayers });
  };

  if (gameState === 'MENU') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-900 text-white font-sans p-4">
        <div className="bg-slate-800 p-8 md:p-10 rounded-[2rem] shadow-2xl w-full max-w-md border-4 border-slate-700 text-center">
          <h1 className="text-6xl font-black mb-10 text-emerald-400 italic tracking-tighter drop-shadow-lg">BOOM.IO</h1>
          <div className="space-y-6">
            <input className="w-full bg-slate-700 p-5 rounded-2xl border-2 border-slate-600 text-xl outline-none focus:border-emerald-500 text-white placeholder-slate-500" placeholder="JOUW NAAM" value={playerName} onChange={e => setPlayerName(e.target.value)} />
            <input className="w-full bg-slate-700 p-5 rounded-2xl border-2 border-slate-600 text-xl outline-none focus:border-emerald-500 uppercase font-mono text-white placeholder-slate-500" placeholder="LOBBY CODE" value={lobbyCode} onChange={e => setLobbyCode(e.target.value)} />
            <button onClick={joinLobby} className="w-full bg-emerald-500 py-5 rounded-2xl font-black text-2xl hover:bg-emerald-400 active:scale-95 transition-all shadow-[0_8px_0_rgb(16,185,129)] text-slate-900">SPEEL NU</button>
            {error && <p className="text-rose-400 font-bold">{error}</p>}
          </div>
        </div>
      </div>
    );
  }

  if (gameState === 'LOBBY') {
    const spelers = lobbyData?.players ? Object.values(lobbyData.players) : [];
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-900 text-white p-4">
        <div className="bg-slate-800 p-10 rounded-[2rem] shadow-xl w-full max-w-md border-4 border-slate-700 text-center">
          <h2 className="text-3xl font-black mb-8 uppercase tracking-tight">LOBBY: <span className="text-emerald-400">{lobbyCode}</span></h2>
          <div className="space-y-4 mb-10 max-h-60 overflow-y-auto pr-2">
            {spelers.map((p, i) => (
              <div key={i} className="bg-slate-700 p-4 rounded-2xl flex items-center justify-between border-2 border-slate-600 animate-in fade-in slide-in-from-bottom-2">
                <span className="font-bold text-lg">{p.name}</span>
                <span className="text-xs font-black bg-emerald-500 text-slate-900 px-3 py-1 rounded-full uppercase">Klaar</span>
              </div>
            ))}
          </div>
          <button onClick={startSpel} className="w-full bg-blue-500 py-5 rounded-2xl font-black text-xl hover:bg-blue-400 flex items-center justify-center gap-3 shadow-[0_8px_0_rgb(59,130,246)] text-white">
            <Play fill="currentColor" /> START GAME
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-slate-950 flex items-center justify-center overflow-hidden cursor-crosshair select-none">
      <div 
        id="game-area" 
        className="relative bg-slate-900 border-[12px] border-slate-800 shadow-2xl overflow-hidden" 
        style={{ width: MAP_WIDTH, height: MAP_HEIGHT }}
      >
        {/* Richtlijn (alleen voor mij) */}
        <svg className="absolute inset-0 pointer-events-none z-10 w-full h-full">
            <line 
                x1={localPos.current.x} y1={localPos.current.y} 
                x2={mousePos.current.x} y2={mousePos.current.y} 
                stroke="rgba(52, 211, 153, 0.2)" strokeWidth="2" strokeDasharray="5,5" 
            />
        </svg>

        <div className="absolute inset-0 opacity-20 pointer-events-none" style={{ backgroundImage: 'linear-gradient(#475569 2px, transparent 2px), linear-gradient(90deg, #475569 2px, transparent 2px)', backgroundSize: '40px 40px' }} />

        {OBSTACLES.map((o, i) => (
          <div key={i} className="absolute bg-slate-700 border-4 border-slate-600 rounded-lg" style={{ left: o.x, top: o.y, width: o.w, height: o.h }} />
        ))}

        {lobbyData?.players && Object.entries(lobbyData.players).map(([id, p]) => {
          if (!p.alive) return null;
          const isMe = id === user?.uid;
          const x = isMe ? localPos.current.x : (p.x || 0);
          const y = isMe ? localPos.current.y : (p.y || 0);
          const reloadProgress = Math.min(100, ((Date.now() - lastShotTime.current) / RELOAD_TIME) * 100);

          return (
            <div key={id} className="absolute z-20" style={{ left: x - 20, top: y - 20, width: 40, height: 40 }}>
              <div className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap px-2 py-0.5 bg-black/60 rounded text-[12px] font-black uppercase text-white border border-white/10">{p.name}</div>
              {isMe && (
                <div className="absolute -top-3 left-0 right-0 h-2 bg-slate-800 rounded-full border border-slate-700 overflow-hidden">
                  <div className="h-full bg-emerald-400" style={{ width: `${reloadProgress}%` }} />
                </div>
              )}
              <div className={`w-full h-full rounded-full border-4 flex items-center justify-center shadow-lg transition-transform ${isMe ? 'bg-blue-600 border-blue-400' : 'bg-rose-600 border-rose-400 animate-pulse'}`}>
                <Shield size={20} className="text-white/40" />
              </div>
            </div>
          );
        })}

        {lobbyData?.bullets?.map(b => {
          const age = (Date.now() - b.createdAt) / 1000;
          if (age > 1.2) return null;
          const curX = b.x + (b.vx * age * 60);
          const curY = b.y + (b.vy * age * 60);
          
          let hitObs = false;
          for(let o of OBSTACLES) {
              if (curX > o.x && curX < o.x + o.w && curY > o.y && curY < o.y + o.h) hitObs = true;
          }
          if (hitObs) return null;

          return (
            <div key={b.id} className="absolute bg-yellow-400 rounded-full w-3 h-3 z-30 shadow-[0_0_15px_#facc15]" 
              style={{ left: curX - 1.5, top: curY - 1.5 }} />
          );
        })}
      </div>

      {gameState === 'DEAD' && (
        <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-xl flex items-center justify-center z-50 p-6">
          <div className="text-center p-10 md:p-16 bg-slate-800 rounded-[3rem] border-8 border-rose-500 shadow-2xl max-w-lg w-full">
            <Skull size={100} className="text-rose-500 mx-auto mb-8" />
            <h2 className="text-5xl md:text-6xl font-black mb-4 text-white italic tracking-tighter uppercase">K.O.</h2>
            <p className="text-slate-400 text-lg mb-10 font-bold">Iemand was sneller dan jij!</p>
            <button onClick={() => window.location.reload()} className="bg-white text-slate-900 px-12 py-5 rounded-2xl font-black text-2xl hover:bg-emerald-400 transition-all flex items-center gap-3 mx-auto shadow-[0_8px_0_#ccc] active:translate-y-1 active:shadow-none">
              <RotateCcw size={28} /> OPNIEUW
            </button>
          </div>
        </div>
      )}
    </div>
  );
}