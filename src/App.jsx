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
import { Crosshair, Shield, Play, Skull, RotateCcw } from 'lucide-react';

// --- CONFIGURATIE ---
// LET OP: Zorg dat FIREBASE_CONFIG goed wordt afgesloten met };
const FIREBASE_CONFIG = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
  apiKey: "AIzaSyDw-WSx1oYTHzadXUB7csmKNhZlO0RTw6Y",
  authDomain: "multiplayer-shooter-c0b9f.firebaseapp.com",
  projectId: "multiplayer-shooter-c0b9f",
  storageBucket: "multiplayer-shooter-c0b9f.firebasestorage.app",
  messagingSenderId: "773037810608",
  appId: "1:773037810608:web:f8b22fc68fa1e0c34f2c75"
}; // <--- Dit is de "}" die waarschijnlijk miste in jouw bestand!

const APP_ID = typeof __app_id !== 'undefined' ? __app_id : 'mijn-shooter-game';

// Initialiseer Firebase
const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

// Game Instellingen
const PLAYER_SPEED = 4;
const BULLET_SPEED = 8;
const RELOAD_TIME = 800; 
const PLAYER_SIZE = 40;
const BULLET_SIZE = 8;
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

  const localPos = useRef({ x: 100, y: 100 });
  const mousePos = useRef({ x: 0, y: 0 });
  const lastShotTime = useRef(0);
  const keysPressed = useRef({});
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
          localPos.current = { x: Math.random() * 600 + 100, y: Math.random() * 400 + 100 };
          requestAnimationFrame(gameLoop);
        }
        if (gameState === 'PLAYING' && data.players?.[user.uid]?.alive === false) {
          setGameState('DEAD');
        }
      }
    }, (err) => console.error("Firestore error:", err));
    return () => unsub();
  }, [user, lobbyCode, gameState]);

  const gameLoop = () => {
    if (gameState !== 'PLAYING') return;
    
    const dx = mousePos.current.x - localPos.current.x;
    const dy = mousePos.current.y - localPos.current.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > 5) {
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

    if (keysPressed.current[' '] && Date.now() - lastShotTime.current > RELOAD_TIME) {
      fireBullet();
    }

    if (lobbyData?.bullets) {
        lobbyData.bullets.forEach(bullet => {
            if (bullet.ownerId !== user.uid) {
                const age = (Date.now() - bullet.createdAt) / 1000;
                const bx = bullet.x + (bullet.vx * age * 60);
                const by = bullet.y + (bullet.vy * age * 60);
                const dist = Math.sqrt(Math.pow(bx - localPos.current.x, 2) + Math.pow(by - localPos.current.y, 2));
                if (dist < (PLAYER_SIZE / 2 + BULLET_SIZE / 2)) {
                    handleDeath();
                }
            }
        });
    }

    const now = Date.now();
    if (now - lastUpdateToDb.current > 50) {
      syncPlayer();
      lastUpdateToDb.current = now;
    }
    gameLoopRef.current = requestAnimationFrame(gameLoop);
  };

  const handleDeath = async () => {
    if (gameState !== 'PLAYING') return;
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
    const handleKeyDown = (e) => keysPressed.current[e.key] = true;
    const handleKeyUp = (e) => keysPressed.current[e.key] = false;
    const handleMouseMove = (e) => {
      const area = document.getElementById('game-area');
      if (area) {
        const rect = area.getBoundingClientRect();
        mousePos.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  const joinLobby = async () => {
    if (!playerName || !lobbyCode) return setError("Naam en code verplicht!");
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    await setDoc(lobbyRef, {
      status: 'WAITING',
      bullets: [],
      players: { [user.uid]: { name: playerName, alive: true, x: 100, y: 100 } }
    }, { merge: true });
    setGameState('LOBBY');
  };

  const startSpel = async () => {
    const lobbyRef = doc(db, 'artifacts', APP_ID, 'public', 'data', 'lobbies', lobbyCode);
    const newPlayers = { ...lobbyData.players };
    Object.keys(newPlayers).forEach(id => newPlayers[id].alive = true);
    await updateDoc(lobbyRef, { status: 'PLAYING', bullets: [], players: newPlayers });
  };

  if (gameState === 'MENU') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-slate-900 text-white p-4 font-sans">
        <div className="bg-slate-800 p-8 rounded-3xl shadow-2xl w-full max-w-md border border-slate-700">
          <h1 className="text-5xl font-black text-center mb-8 text-emerald-400 italic">BOOM.IO</h1>
          <div className="space-y-4">
            {error && <p className="text-rose-400 text-center text-sm font-bold">{error}</p>}
            <input className="w-full bg-slate-700 p-4 rounded-xl border border-slate-600 outline-none focus:border-emerald-500" placeholder="Naam" value={playerName} onChange={e => setPlayerName(e.target.value)} />
            <input className="w-full bg-slate-700 p-4 rounded-xl border border-slate-600 outline-none focus:border-emerald-500 uppercase font-mono" placeholder="Lobby Code" value={lobbyCode} onChange={e => setLobbyCode(e.target.value)} />
            <button onClick={joinLobby} className="w-full bg-emerald-500 py-4 rounded-xl font-bold text-xl hover:bg-emerald-400 active:scale-95 transition-all">SPEEL NU</button>
          </div>
        </div>
      </div>
    );
  }

  if (gameState === 'LOBBY') {
    const spelers = lobbyData?.players ? Object.values(lobbyData.players) : [];
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-slate-900 text-white">
        <div className="bg-slate-800 p-8 rounded-3xl shadow-xl w-full max-w-md border border-slate-700 text-center">
          <h2 className="text-2xl font-bold mb-6">LOBBY: {lobbyCode}</h2>
          <div className="space-y-3 mb-8">
            {spelers.map((p, i) => (
              <div key={i} className="bg-slate-700/50 p-4 rounded-xl flex items-center justify-between border border-slate-600">
                <span className="font-bold">{p.name}</span>
                <span className="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-1 rounded">READY</span>
              </div>
            ))}
          </div>
          <button onClick={startSpel} className="w-full bg-blue-600 py-4 rounded-xl font-bold text-lg hover:bg-blue-500 flex items-center justify-center gap-2">
            <Play size={20} /> START GAME
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-screen bg-slate-950 flex items-center justify-center overflow-hidden cursor-crosshair">
      <div id="game-area" className="relative bg-slate-900 border-8 border-slate-800 shadow-2xl" style={{ width: MAP_WIDTH, height: MAP_HEIGHT }}>
        <div className="absolute inset-0 opacity-10 pointer-events-none" style={{ backgroundImage: 'linear-gradient(#475569 1px, transparent 1px), linear-gradient(90deg, #475569 1px, transparent 1px)', backgroundSize: '50px 50px' }} />

        {OBSTACLES.map((o, i) => (
          <div key={i} className="absolute bg-slate-700 border-2 border-slate-600 rounded-sm" style={{ left: o.x, top: o.y, width: o.w, height: o.h }} />
        ))}

        {lobbyData?.players && Object.entries(lobbyData.players).map(([id, p]) => {
          if (!p.alive) return null;
          const isMe = id === user?.uid;
          const x = isMe ? localPos.current.x : (p.x || 0);
          const y = isMe ? localPos.current.y : (p.y || 0);
          const reloadProgress = Math.min(100, ((Date.now() - lastShotTime.current) / RELOAD_TIME) * 100);

          return (
            <div key={id} className="absolute transition-all duration-75 ease-linear" style={{ left: x - 20, top: y - 20, width: 40, height: 40 }}>
              <div className="absolute -top-7 left-0 right-0 text-center text-[11px] font-black uppercase text-white drop-shadow-md">{p.name}</div>
              {isMe && (
                <div className="absolute -top-2 left-0 right-0 h-1.5 bg-slate-800 rounded-full border border-slate-700">
                  <div className="h-full bg-emerald-400 transition-all duration-75" style={{ width: `${reloadProgress}%` }} />
                </div>
              )}
              <div className={`w-full h-full rounded-full border-4 flex items-center justify-center shadow-xl ${isMe ? 'bg-blue-500 border-blue-300' : 'bg-rose-500 border-rose-300'}`}>
                <Shield size={18} className="text-white/50" />
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
            <div key={b.id} className="absolute bg-yellow-300 rounded-full w-2.5 h-2.5 shadow-[0_0_12px_#fde047]" 
              style={{ left: curX - 5, top: curY - 5 }} />
          );
        })}
      </div>

      {gameState === 'DEAD' && (
        <div className="absolute inset-0 bg-slate-900/90 backdrop-blur-md flex items-center justify-center z-50">
          <div className="text-center p-12 bg-slate-800 rounded-[3rem] border-4 border-rose-500 shadow-2xl">
            <Skull size={80} className="text-rose-500 mx-auto mb-6 animate-bounce" />
            <h2 className="text-5xl font-black mb-2 text-white italic">GEËLIMINEERD</h2>
            <button onClick={() => window.location.reload()} className="bg-white text-slate-900 px-10 py-4 rounded-2xl font-black text-xl hover:bg-emerald-400 mt-6 flex items-center gap-2 mx-auto">
              <RotateCcw size={24} /> OPNIEUW
            </button>
          </div>
        </div>
      )}
    </div>
  );
}