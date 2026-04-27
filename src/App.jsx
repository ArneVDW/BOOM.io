import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { 
  Skull, Crosshair, Trophy, Play, Map as MapIcon, Save, 
  Trash2, ArrowLeft, Download, Upload, Globe, Heart, 
  User, ChevronLeft, CloudUpload, Undo, Grid, Maximize
} from 'lucide-react';

// --- CONFIGURATIE ---
const SERVER_URL = "https://thin-exp-files-falling.trycloudflare.com";

// --- GAME BALANS ---
const ACCELERATION = 0.4; 
const FRICTION = 0.92;
const MAX_SPEED = 5; 
const DASH_SPEED = 18; 
const DASH_COOLDOWN = 5000;
const BULLET_SPEED = 35; 
const RELOAD_TIME = 400;
const BULLET_LIFESPAN = 1500; 
const WIN_SCORE = 5; 
const MOUSE_DEADZONE = 60; 

// Standaard map blokken
const DEFAULT_OBSTACLES = [
  { x: 1000, y: 700, w: 400, h: 400 }, 
  { x: 400, y: 400, w: 200, h: 50 },
  { x: 1800, y: 400, w: 200, h: 50 },
  { x: 400, y: 1350, w: 200, h: 50 },
  { x: 1800, y: 1350, w: 200, h: 50 },
  { x: 200, y: 600, w: 50, h: 600 },
  { x: 2150, y: 600, w: 50, h: 600 }
];

// Helper: Check botsing
function isInObstacle(x, y, mapData, margin = 40) {
  return mapData.some(o => 
    x > o.x - margin && x < o.x + o.w + margin &&
    y > o.y - margin && y < o.y + o.h + margin
  );
}

// Helper: Veilige spawnplek (Nu met dynamische map grootte)
function findSafeSpawn(mapData, mapSize) {
  let attempts = 0;
  while (attempts < 100) {
    const x = Math.random() * (mapSize.w - 200) + 100;
    const y = Math.random() * (mapSize.h - 200) + 100;
    if (!isInObstacle(x, y, mapData)) return { x, y };
    attempts++;
  }
  return { x: mapSize.w / 2, y: mapSize.h / 2 }; 
}

export default function App() {
  const [socket, setSocket] = useState(null);
  const [gameState, setGameState] = useState('MENU'); // MENU, LOBBY, PLAYING, DEAD, WINNER, EDITOR
  const [lobbyCode, setLobbyCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [lobbyData, setLobbyData] = useState(null);
  const [screenSize, setScreenSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [deathTimer, setDeathTimer] = useState(0);
  const [winnerName, setWinnerName] = useState('');

  // Workshop State
  const [isWorkshopOpen, setIsWorkshopOpen] = useState(false);
  const [workshopMaps, setWorkshopMaps] = useState([]);

  // Map Editor & Sync State
  const [mapSize, setMapSize] = useState(() => {
    const saved = localStorage.getItem('customMapSize');
    return saved ? JSON.parse(saved) : { w: 2400, h: 1800 };
  });
  const [activeMap, setActiveMap] = useState(() => {
    const saved = localStorage.getItem('customMap');
    return saved ? JSON.parse(saved) : DEFAULT_OBSTACLES;
  });
  
  // Builder Extra's
  const [history, setHistory] = useState([]);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState({x: 0, y: 0});
  const [drawCurrent, setDrawCurrent] = useState({x: 0, y: 0});

  // Refs voor prestaties in loops
  const gameStateRef = useRef(gameState);
  const activeMapRef = useRef(activeMap);
  const mapSizeRef = useRef(mapSize);
  const lobbyDataRef = useRef(null); 
  const canvasRef = useRef(null);
  
  const pos = useRef({ x: 1200, y: 900 });
  const vel = useRef({ x: 0, y: 0 });
  const mousePosScreen = useRef({ x: 0, y: 0 }); 
  const keysPressed = useRef({});
  const lastShotTime = useRef(0);
  const lastDashTime = useRef(0);
  const frameRef = useRef();
  const deathIntervalRef = useRef();
  const lastRespawnTime = useRef(0);
  const editorCam = useRef({x: 0, y: 0});

  useEffect(() => { gameStateRef.current = gameState; }, [gameState]);
  useEffect(() => { activeMapRef.current = activeMap; }, [activeMap]);
  useEffect(() => { mapSizeRef.current = mapSize; }, [mapSize]);

  // 1. Socket Verbinding & Event Listeners
  useEffect(() => {
    const s = io(SERVER_URL);
    setSocket(s);

    s.on('workshopList', (maps) => setWorkshopMaps(maps));
    s.on('mapLoaded', (mapData) => {
        if (mapData) {
            // Als de server mapData doorgeeft met mapSize property
            if (mapData.mapSize) setMapSize(mapData.mapSize);
            const obstacles = mapData.mapData || mapData; 
            setActiveMap(obstacles);
            localStorage.setItem('customMap', JSON.stringify(obstacles));
            setIsWorkshopOpen(false);
            alert("Map uit workshop succesvol ingeladen!");
        }
    });
    
    s.on('uploadSuccess', () => {
        alert("Je map is succesvol geüpload naar de server!");
        s.emit('getWorkshop');
    });

    s.on('lobbyUpdate', (data) => {
      setLobbyData(data); 
      lobbyDataRef.current = data; 
      
      // SYNC MAP (Voor clients die niet de host zijn)
      if (data.customMap && data.customMap.length > 0 && gameStateRef.current === 'LOBBY') {
         if (JSON.stringify(data.customMap) !== JSON.stringify(activeMapRef.current)) {
             setActiveMap(data.customMap);
             if (data.mapSize) setMapSize(data.mapSize);
         }
      }

      // Check Winnaar
      const winningPlayerId = Object.keys(data.players || {}).find(id => data.players[id].score >= WIN_SCORE);
      if ((winningPlayerId || data.winner) && gameStateRef.current !== 'WINNER') {
          const wName = data.winner || data.players[winningPlayerId].name;
          setWinnerName(wName);
          setGameState('WINNER');
          if (deathIntervalRef.current) clearInterval(deathIntervalRef.current);
          return; 
      }

      // Terug naar lobby via server reset (bijv. als host op "Terug naar Lobby" klikt)
      if (data.status === 'LOBBY' && gameStateRef.current === 'WINNER') {
          setGameState('LOBBY');
          setWinnerName('');
      }

      // SPEL LOGICA
      if (data.status === 'PLAYING' && gameStateRef.current !== 'WINNER') {
        // Initiele Spawn vanuit Lobby
        if (gameStateRef.current === 'LOBBY') {
          const myData = data.players[s.id];
          let startX = myData ? myData.x : mapSizeRef.current.w / 2;
          let startY = myData ? myData.y : mapSizeRef.current.h / 2;

          if (isInObstacle(startX, startY, activeMapRef.current)) {
             const safe = findSafeSpawn(activeMapRef.current, mapSizeRef.current);
             startX = safe.x;
             startY = safe.y;
             s.emit('move', { x: startX, y: startY });
          }

          pos.current = { x: startX, y: startY };
          vel.current = { x: 0, y: 0 };
          setGameState('PLAYING');
        }

        // Check voor eliminatie (Stuck-in-dead bugfix: buffer naar 3500ms)
        const myData = data.players[s.id];
        if (gameStateRef.current === 'PLAYING' && myData?.alive === false) {
          if (Date.now() - lastRespawnTime.current > 3500) {
            startDeathSequence(s);
          }
        }
      }
    });

    const handleResize = () => setScreenSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', handleResize);
    window.addEventListener('keydown', (e) => keysPressed.current[e.key.toLowerCase()] = true);
    window.addEventListener('keyup', (e) => keysPressed.current[e.key.toLowerCase()] = false);

    return () => {
      s.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, []); 

  // 2. Render Loop
  useEffect(() => {
    if (gameState === 'MENU' || gameState === 'LOBBY' || gameState === 'WINNER') return;

    const render = () => {
      if (gameStateRef.current === 'PLAYING') {
        updatePhysics();
        drawGame();
      } else if (gameStateRef.current === 'DEAD') {
        drawGame(); 
      } else if (gameStateRef.current === 'EDITOR') {
        updateEditorPhysics();
        drawEditor();
      }
      frameRef.current = requestAnimationFrame(render);
    };

    frameRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frameRef.current);
  }, [gameState, screenSize, activeMap, mapSize]);

  // BUGFIX: Veiligere death sequence
  const startDeathSequence = (currentSocket) => {
    if (gameStateRef.current === 'DEAD' || gameStateRef.current === 'WINNER') return;
    setGameState('DEAD');
    setDeathTimer(5);
    
    if (deathIntervalRef.current) clearInterval(deathIntervalRef.current);
    
    deathIntervalRef.current = setInterval(() => {
      setDeathTimer(prev => {
        if (prev <= 1) {
          clearInterval(deathIntervalRef.current);
          
          const safe = findSafeSpawn(activeMapRef.current, mapSizeRef.current);
          pos.current = safe;
          vel.current = { x: 0, y: 0 };
          
          currentSocket.emit('move', safe);
          currentSocket.emit('respawn');
          
          lastRespawnTime.current = Date.now();
          
          // Optimistische update om te voorkomen dat de client direct weer sterft
          if (lobbyDataRef.current && lobbyDataRef.current.players[currentSocket.id]) {
              lobbyDataRef.current.players[currentSocket.id].alive = true;
          }

          setGameState('PLAYING');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const performShoot = () => {
      if (gameStateRef.current !== 'PLAYING') return;
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
    if (!socket || !lobbyDataRef.current) return;

    const centerX = screenSize.w / 2;
    const centerY = screenSize.h / 2;
    const dx = mousePosScreen.current.x - centerX;
    const dy = mousePosScreen.current.y - centerY;
    const dist = Math.sqrt(dx*dx + dy*dy);

    if (dist > MOUSE_DEADZONE) {
      vel.current.x += (dx / dist) * ACCELERATION;
      vel.current.y += (dy / dist) * ACCELERATION;
    }

    if (keysPressed.current['shift'] && Date.now() - lastDashTime.current > DASH_COOLDOWN) {
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

    // Map grenzen
    if (nextX < r) nextX = r; if (nextX > mapSizeRef.current.w - r) nextX = mapSizeRef.current.w - r;
    if (nextY < r) nextY = r; if (nextY > mapSizeRef.current.h - r) nextY = mapSizeRef.current.h - r;

    // Obstakels
    if (!isInObstacle(nextX, pos.current.y, activeMapRef.current, r)) {
        pos.current.x = nextX;
    } else {
        vel.current.x *= 0.5;
    }

    if (!isInObstacle(pos.current.x, nextY, activeMapRef.current, r)) {
        pos.current.y = nextY;
    } else {
        vel.current.y *= 0.5;
    }

    if (keysPressed.current[' ']) performShoot();

    socket.emit('move', { x: pos.current.x, y: pos.current.y });
  };

  const drawGame = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const camX = pos.current.x - screenSize.w / 2;
    const camY = pos.current.y - screenSize.h / 2;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, screenSize.w, screenSize.h);

    ctx.save();
    ctx.translate(-camX, -camY);

    // Raster & Wereld grenzen
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= mapSizeRef.current.w; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, mapSizeRef.current.h); }
    for (let y = 0; y <= mapSizeRef.current.h; y += 100) { ctx.moveTo(0, y); ctx.lineTo(mapSizeRef.current.w, y); }
    ctx.stroke();
    
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 10;
    ctx.strokeRect(0, 0, mapSizeRef.current.w, mapSizeRef.current.h);

    // Actieve Map Obstakels
    ctx.fillStyle = '#334155';
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 4;
    activeMapRef.current.forEach(o => {
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeRect(o.x, o.y, o.w, o.h);
    });

    // Kogels
    ctx.fillStyle = '#fbbf24';
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#fbbf24';
    lobbyDataRef.current?.bullets?.forEach(b => {
      ctx.beginPath();
      ctx.arc(b.x, b.y, 5, 0, Math.PI * 2); 
      ctx.fill();
    });
    ctx.shadowBlur = 0;

    // Spelers
    Object.entries(lobbyDataRef.current?.players || {}).forEach(([id, p]) => {
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

    // HUD balkjes
    const now = Date.now();
    const timeSinceShot = now - lastShotTime.current;
    if (timeSinceShot < RELOAD_TIME && gameStateRef.current === 'PLAYING') {
      const pct = timeSinceShot / RELOAD_TIME;
      ctx.fillStyle = '#334155';
      ctx.fillRect(pos.current.x - 20, pos.current.y + 30, 40, 4);
      ctx.fillStyle = '#fff';
      ctx.fillRect(pos.current.x - 20, pos.current.y + 30, 40 * pct, 4);
    }

    const timeSinceDash = now - lastDashTime.current;
    if (timeSinceDash < DASH_COOLDOWN && gameStateRef.current === 'PLAYING') {
      const pct = timeSinceDash / DASH_COOLDOWN;
      ctx.fillStyle = '#1e3a8a';
      ctx.fillRect(pos.current.x - 20, pos.current.y + 36, 40, 4);
      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(pos.current.x - 20, pos.current.y + 36, 40 * pct, 4);
    }
    ctx.restore();

    // Crosshair
    if (gameStateRef.current === 'PLAYING') {
      const mx = mousePosScreen.current.x;
      const my = mousePosScreen.current.y;
      ctx.strokeStyle = '#10b981'; 
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(mx, my, 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#10b981';
      ctx.beginPath();
      ctx.arc(mx, my, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Minimap
    const mmScale = 0.08;
    const mmW = mapSizeRef.current.w * mmScale;
    const mmH = mapSizeRef.current.h * mmScale;
    const mmX = screenSize.w - mmW - 20;
    const mmY = 20;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
    ctx.fillRect(mmX, mmY, mmW, mmH);
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 2;
    ctx.strokeRect(mmX, mmY, mmW, mmH);
    
    Object.entries(lobbyDataRef.current?.players || {}).forEach(([id, p]) => {
      if (!p.alive) return;
      ctx.fillStyle = id === socket.id ? '#3b82f6' : '#ef4444';
      ctx.beginPath();
      const px = id === socket.id ? pos.current.x : p.x;
      const py = id === socket.id ? pos.current.y : p.y;
      ctx.arc(mmX + px * mmScale, mmY + py * mmScale, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  // --- MAP EDITOR LOGICA (GEAVANCEERD) ---
  const updateEditorPhysics = () => {
    const speed = 15;
    if (keysPressed.current['w']) editorCam.current.y -= speed;
    if (keysPressed.current['s']) editorCam.current.y += speed;
    if (keysPressed.current['a']) editorCam.current.x -= speed;
    if (keysPressed.current['d']) editorCam.current.x += speed;

    editorCam.current.x = Math.max(0, Math.min(mapSizeRef.current.w - screenSize.w + 100, editorCam.current.x));
    editorCam.current.y = Math.max(0, Math.min(mapSizeRef.current.h - screenSize.h + 100, editorCam.current.y));
  };

  const drawEditor = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, screenSize.w, screenSize.h);

    ctx.save();
    ctx.translate(-editorCam.current.x, -editorCam.current.y);

    // Grid (Dikke lijnen als snapping aan staat)
    ctx.strokeStyle = snapToGrid ? '#334155' : '#1e293b';
    ctx.lineWidth = snapToGrid ? 2 : 1;
    const step = snapToGrid ? 50 : 100;
    ctx.beginPath();
    for (let x = 0; x <= mapSizeRef.current.w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, mapSizeRef.current.h); }
    for (let y = 0; y <= mapSizeRef.current.h; y += step) { ctx.moveTo(0, y); ctx.lineTo(mapSizeRef.current.w, y); }
    ctx.stroke();

    // Map grenzen
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 6;
    ctx.strokeRect(0, 0, mapSizeRef.current.w, mapSizeRef.current.h);

    // Huidige Blokken
    ctx.fillStyle = '#334155';
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 4;
    activeMapRef.current.forEach(o => {
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeRect(o.x, o.y, o.w, o.h);
    });

    // Teken nieuw blok met afmetingen preview
    if (isDrawing) {
      ctx.fillStyle = 'rgba(16, 185, 129, 0.4)';
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 2;
      const x = Math.min(drawStart.x, drawCurrent.x);
      const y = Math.min(drawStart.y, drawCurrent.y);
      const w = Math.abs(drawCurrent.x - drawStart.x);
      const h = Math.abs(drawCurrent.y - drawStart.y);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      
      // Tekst met afmetingen
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${w} x ${h}`, x + w/2, y + h/2 + 6);
    }
    
    ctx.restore();

    // Editor UI Hint
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText("WASD = Camera  |  Muis = Blok Tekenen", screenSize.w / 2, screenSize.h - 30);
  };

  const getSnappedCoords = (e) => {
    let x = e.clientX + editorCam.current.x;
    let y = e.clientY + editorCam.current.y;
    if (snapToGrid) {
      x = Math.round(x / 50) * 50;
      y = Math.round(y / 50) * 50;
    }
    return { x, y };
  };

  const handleEditorMouseDown = (e) => {
    if (gameState !== 'EDITOR') return;
    const { x, y } = getSnappedCoords(e);
    setDrawStart({x, y});
    setDrawCurrent({x, y});
    setIsDrawing(true);
  };

  const handleEditorMouseMove = (e) => {
    if (gameState !== 'EDITOR') {
      mousePosScreen.current = { x: e.clientX, y: e.clientY };
      return;
    }
    if (isDrawing) {
      setDrawCurrent(getSnappedCoords(e));
    }
  };

  const handleEditorMouseUp = () => {
    if (gameState !== 'EDITOR' || !isDrawing) return;
    setIsDrawing(false);
    
    const x = Math.min(drawStart.x, drawCurrent.x);
    const y = Math.min(drawStart.y, drawCurrent.y);
    const w = Math.abs(drawCurrent.x - drawStart.x);
    const h = Math.abs(drawCurrent.y - drawStart.y);
    
    // Voeg toe als het blok groot genoeg is
    if (w >= 20 && h >= 20) {
      setHistory(prev => [...prev, activeMap]); // Sla geschiedenis op voor Undo
      setActiveMap(prev => [...prev, {x, y, w, h}]);
    }
  };

  const undoLastBlock = () => {
    if (history.length > 0) {
      setActiveMap(history[history.length - 1]);
      setHistory(prev => prev.slice(0, -1));
    }
  };

  const saveEditorMap = () => {
    localStorage.setItem('customMap', JSON.stringify(activeMap));
    localStorage.setItem('customMapSize', JSON.stringify(mapSize));
    setGameState('MENU');
  };

  const exportMapCode = () => {
    const payload = { mapSize, mapData: activeMap };
    const code = btoa(JSON.stringify(payload));
    navigator.clipboard.writeText(code);
    alert('Map Code gekopieerd! Deel deze met je vrienden.');
  };

  const importMapCode = () => {
    const code = prompt('Plak hier de Map Code van je vriend:');
    if (code) {
      try {
        const decoded = JSON.parse(atob(code));
        // Backwards compatibility check
        if (Array.isArray(decoded)) {
            setActiveMap(decoded);
            setMapSize({w: 2400, h: 1800}); // Default size
        } else {
            setActiveMap(decoded.mapData);
            setMapSize(decoded.mapSize);
        }
        localStorage.setItem('customMap', JSON.stringify(activeMap));
      } catch(e) {
        alert('Ongeldige Map Code!');
      }
    }
  };

  // --- WORKSHOP FUNCTIES ---
  const openWorkshop = () => {
      if (socket) {
          socket.emit('getWorkshop');
          setIsWorkshopOpen(true);
      } else {
          alert("Verbinden met de server...");
      }
  };

  const uploadMapToServer = () => {
      if (!socket) return alert("Geen verbinding met de server!");
      
      const name = prompt("Hoe wil je deze map noemen?");
      if (!name) return;
      
      let pName = playerName || prompt("Wat is jouw naam (maker)?");
      if (!pName) return;
      if (!playerName) setPlayerName(pName); 
      
      socket.emit('uploadMap', { name, creator: pName, mapData: activeMap, mapSize });
  };


  // --- MENU & LOBBY FUNCTIES ---
  const join = () => {
    if (!playerName || !lobbyCode || !socket) return;
    // Host stuurt zijn map en size naar de server!
    socket.emit('joinLobby', { lobbyCode: lobbyCode.toUpperCase(), playerName, customMap: activeMap, mapSize: mapSize });
    setGameState('LOBBY');
  };

  const startMatch = () => {
    socket.emit('startMatch');
  };

  const returnToLobbyFromWin = () => {
    setGameState('LOBBY');
    setWinnerName('');
    if (socket) socket.emit('returnToLobby');
  };

  // --- UI SCHERMEN ---

  if (isWorkshopOpen) return (
    <div className="fixed inset-0 bg-slate-950 text-white p-6 overflow-y-auto z-[300] font-sans">
      <div className="max-w-5xl mx-auto">
        <div className="flex justify-between items-center mb-10 mt-6">
          <div>
            <h2 className="text-5xl font-black italic text-emerald-400 tracking-tighter">PI WORKSHOP</h2>
            <p className="text-slate-500 font-bold uppercase tracking-widest text-sm">Door de community gebouwde mappen</p>
          </div>
          <button onClick={() => setIsWorkshopOpen(false)} className="bg-slate-800 p-4 rounded-2xl hover:bg-rose-500 transition-colors">
            <ChevronLeft size={32}/>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pb-20">
          {workshopMaps.length === 0 && (
            <div className="col-span-full bg-slate-900 p-10 rounded-[2.5rem] border-2 border-slate-800 text-center">
              <Globe size={48} className="mx-auto text-slate-600 mb-4" />
              <p className="text-slate-400 font-bold text-xl">Geen mappen gevonden...</p>
              <p className="text-slate-500">Bouw de eerste map in de editor en upload hem!</p>
            </div>
          )}
          
          {workshopMaps.map(m => {
            // Bereken de preview layout op basis van de server map
            const wSize = m.mapSize?.w || 2400;
            const hSize = m.mapSize?.h || 1800;
            const wData = m.mapData || [];
            
            return (
              <div key={m.id} className="bg-slate-900 border-2 border-slate-800 p-6 rounded-[2.5rem] flex flex-col gap-4 hover:border-emerald-500/50 transition-colors">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-2xl font-black text-white uppercase">{m.name}</h3>
                    <p className="text-emerald-500 flex items-center gap-2 font-bold mt-1 text-sm"><User size={16}/> Door: {m.creator}</p>
                  </div>
                  <button 
                    onClick={() => socket.emit('likeMap', m.id)} 
                    className="flex items-center gap-1 text-rose-500 font-bold bg-rose-500/10 hover:bg-rose-500/20 px-3 py-1 rounded-full transition-colors"
                  >
                    <Heart size={16} fill="currentColor"/> {m.likes || 0}
                  </button>
                </div>
                
                {/* Dynamische Map Preview (SVG) */}
                <div className="w-full h-40 bg-slate-950 rounded-2xl overflow-hidden border border-slate-800 p-2">
                   <svg viewBox={`0 0 ${wSize} ${hSize}`} className="w-full h-full opacity-80" preserveAspectRatio="xMidYMid meet">
                      {/* Achtergrond raster preview */}
                      <rect width="100%" height="100%" fill="#0f172a" />
                      {wData.map((obs, i) => (
                          <rect key={i} x={obs.x} y={obs.y} width={obs.w} height={obs.h} fill="#334155" stroke="#64748b" strokeWidth="15" />
                      ))}
                   </svg>
                </div>

                <div className="flex justify-between items-center bg-slate-950 rounded-xl p-3 border border-slate-800">
                  <span className="text-slate-400 text-xs font-bold tracking-widest uppercase">{wData.length} obstakels</span>
                  <span className="text-slate-400 text-xs font-bold tracking-widest uppercase">{wSize}x{hSize} px</span>
                </div>

                <button 
                  onClick={() => socket.emit('loadMapDetails', m.id)}
                  className="w-full bg-emerald-500 text-slate-900 font-black py-4 rounded-2xl uppercase hover:scale-[1.02] active:scale-[0.98] transition-transform shadow-[0_4px_0_rgb(16,185,129)] active:shadow-none active:translate-y-1 mt-2"
                >
                  Laad deze Map
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  if (gameState === 'MENU') return (
    <div className="w-full h-screen bg-slate-950 flex items-center justify-center text-white font-sans overflow-hidden">
      <div className="bg-slate-900 p-12 rounded-[3rem] shadow-2xl w-full max-w-sm border-b-8 border-emerald-500/20 text-center relative">
        <Crosshair size={60} className="text-emerald-400 mx-auto mb-6 animate-pulse" />
        <h1 className="text-5xl font-black mb-10 italic tracking-tighter">BOOM.IO</h1>
        <input className="w-full bg-slate-800 p-4 rounded-2xl mb-4 border border-slate-700 outline-none focus:border-emerald-500 text-white" placeholder="JOUW NAAM" value={playerName} onChange={e => setPlayerName(e.target.value)} />
        <input className="w-full bg-slate-800 p-4 rounded-2xl mb-8 border border-slate-700 outline-none focus:border-emerald-500 uppercase text-white font-bold" placeholder="LOBBY CODE" value={lobbyCode} onChange={e => setLobbyCode(e.target.value)} />
        <button onClick={join} className="w-full bg-emerald-500 py-5 rounded-2xl font-black text-xl hover:bg-emerald-400 text-slate-900 shadow-[0_6px_0_rgb(16,185,129)] active:translate-y-1 transition-all uppercase mb-6">Speel Nu</button>
        
        <div className="border-t border-slate-800 pt-6 mt-2 flex flex-col gap-3">
          <button onClick={() => setGameState('EDITOR')} className="w-full bg-slate-800 py-4 rounded-2xl font-bold text-slate-300 hover:bg-slate-700 flex justify-center items-center gap-2 transition-colors">
            <MapIcon size={18} /> Map Builder
          </button>
          
          <button onClick={openWorkshop} className="w-full bg-blue-600 py-4 rounded-2xl font-bold text-slate-100 hover:bg-blue-500 flex justify-center items-center gap-2 transition-colors">
            <Globe size={18} /> Community Workshop
          </button>

          <button onClick={importMapCode} className="w-full bg-slate-800 py-3 mt-2 rounded-2xl font-bold text-xs text-slate-400 hover:text-emerald-400 flex justify-center items-center gap-2 transition-colors">
            <Download size={14} /> Importeer Map via Code
          </button>
        </div>
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
        <div className="bg-slate-950/50 rounded-xl p-3 mb-6 border border-slate-800 flex justify-between items-center">
            <span className="text-xs font-bold text-slate-400 uppercase">Gekozen Map Grootte</span>
            <span className="text-xs font-bold text-emerald-400">{mapSize.w}x{mapSize.h}</span>
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
            <p className="text-4xl font-bold mb-10 text-white">{winnerName}</p>
            {/* Keert terug naar lobby in plaats van page reload */}
            <button onClick={returnToLobbyFromWin} className="bg-white text-slate-900 px-10 py-5 rounded-full font-black uppercase hover:bg-emerald-400 transition-colors shadow-lg">Terug naar Lobby</button>
        </div>
    </div>
  );

  return (
    // Zichtbare cursor in de editor en menu's. Onzichtbaar in de game.
    <div className={`fixed inset-0 bg-black overflow-hidden ${gameState === 'EDITOR' ? 'cursor-default' : 'cursor-none'}`}>
      
      {/* HUD OVERLAY VOOR EDITOR */}
      {gameState === 'EDITOR' && (
        <div className="absolute top-4 left-4 z-50 flex flex-col gap-3 cursor-default">
           <div className="flex gap-2">
               <button onClick={saveEditorMap} className="bg-emerald-500 text-white px-5 py-3 rounded-xl font-bold flex items-center gap-2 hover:bg-emerald-400 shadow-lg"><Save size={18}/> Opslaan & Terug</button>
               <button onClick={uploadMapToServer} className="bg-purple-600 text-white px-5 py-3 rounded-xl font-bold flex items-center gap-2 hover:bg-purple-500 shadow-lg"><CloudUpload size={18}/> Uploaden</button>
               <button onClick={exportMapCode} className="bg-slate-700 text-white px-5 py-3 rounded-xl font-bold flex items-center gap-2 hover:bg-slate-600 shadow-lg"><Upload size={18}/> Code</button>
           </div>
           
           <div className="flex gap-2 bg-slate-900/80 p-2 rounded-xl border border-slate-700 backdrop-blur">
               <div className="flex items-center gap-2 bg-slate-800 px-3 py-2 rounded-lg text-sm font-bold text-white">
                   <Maximize size={16} className="text-emerald-400"/> Map:
                   <select 
                      className="bg-transparent outline-none text-emerald-400 cursor-pointer ml-1"
                      value={`${mapSize.w}x${mapSize.h}`}
                      onChange={(e) => {
                          const [w, h] = e.target.value.split('x').map(Number);
                          setMapSize({w, h});
                      }}
                   >
                       <option value="1600x1200">Klein (1600x1200)</option>
                       <option value="2400x1800">Medium (2400x1800)</option>
                       <option value="3200x2400">Groot (3200x2400)</option>
                   </select>
               </div>

               <button 
                  onClick={() => setSnapToGrid(!snapToGrid)} 
                  className={`px-4 py-2 rounded-lg font-bold flex items-center gap-2 text-sm transition-colors ${snapToGrid ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400'}`}
               >
                  <Grid size={16}/> Snap {snapToGrid ? 'AAN' : 'UIT'}
               </button>

               <button onClick={undoLastBlock} disabled={history.length === 0} className="bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2 hover:bg-slate-700"><Undo size={16}/> Undo</button>
               <button onClick={() => { setHistory(prev => [...prev, activeMap]); setActiveMap([]); }} className="bg-rose-500/20 text-rose-500 hover:bg-rose-500 hover:text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2 transition-colors"><Trash2 size={16}/> Wis</button>
           </div>
        </div>
      )}

      <canvas 
        ref={canvasRef}
        width={screenSize.w}
        height={screenSize.h}
        onMouseMove={handleEditorMouseMove}
        onMouseDown={gameState === 'EDITOR' ? handleEditorMouseDown : performShoot}
        onMouseUp={handleEditorMouseUp}
      />
      
      {/* IN-GAME HUD */}
      {(gameState === 'PLAYING' || gameState === 'DEAD') && (
        <div className="absolute top-4 left-4 bg-black/40 p-4 rounded-xl backdrop-blur-sm border border-white/10 text-white pointer-events-none select-none z-10">
          <h3 className="font-bold text-xs uppercase text-slate-400 mb-2 italic">Top Spelers (Doel: {WIN_SCORE})</h3>
          {Object.values(lobbyData?.players || {})
              .sort((a,b) => b.score - a.score)
              .map((p, i) => (
                <div key={i} className="flex justify-between w-40 text-sm mb-1">
                    <span className={p.id === socket?.id ? "text-blue-400 font-bold" : "text-white"}>{i+1}. {p.name}</span>
                    <span className="font-mono text-yellow-400 font-bold">{p.score || 0}</span>
                </div>
            ))}
        </div>
      )}

      {/* DEATH SCREEN */}
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

      {/* IN-GAME CONTROLS HINT */}
      {gameState === 'PLAYING' && (
        <div className="absolute bottom-4 left-4 text-white/50 font-sans text-xs pointer-events-none font-bold tracking-widest uppercase">
          KLIK = Schieten | SHIFT = Dash
        </div>
      )}
    </div>
  );
}
