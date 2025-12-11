
const WebSocket = require('ws');
const Filter = require('bad-words'); // <--- Import the library

const port = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port });
console.log('WS relay listening on port', port);

const clients = new Map(); // ws -> id
const playerStates = {};   // id -> {x, y, color, username}

// ==========================================
// CENSORSHIP CONFIGURATION
// ==========================================
const filter = new Filter();

// Optional: Add custom words specific to your game if the library misses them
filter.addWords('admin', 'mod', 'server'); 

// Helper function to clean text
function sanitize(text) {
    if (!text) return "";
    try {
        return filter.clean(text); // This replaces bad words with * automatically
    } catch (e) {
        // Fallback in case something weird happens
        return text; 
    }
}
// ==========================================

function broadcast(msg, except=null){
    const raw = JSON.stringify(msg);
    for(const client of wss.clients){
        if(client.readyState===WebSocket.OPEN && client!==except){
            client.send(raw);
        }
    }
}

wss.on('connection', ws => {
    let myId = null;

    ws.on('message', data => {
        try{
            const msg = JSON.parse(data);

            if(msg.type==="join"){
                myId = msg.id;
                clients.set(ws, myId);

                // 1. Sanitize Username
                // Clean the word and limit length
                let cleanUsername = sanitize(msg.username).substring(0, 12) || "Player";
                
                // Extra check: if the username was purely bad words (now mostly ****), reset it
                if(cleanUsername.includes('***')) cleanUsername = "Guest";

                playerStates[myId] = { 
                    x: msg.x, 
                    y: msg.y, 
                    color: msg.color,
                    username: cleanUsername 
                };

                broadcast({
                    type: "join",
                    id: myId,
                    x: msg.x,
                    y: msg.y,
                    color: msg.color,
                    username: cleanUsername
                }, ws);

                ws.send(JSON.stringify({
                    type: "welcome",
                    id: myId,
                    peers: Object.keys(playerStates).map(pid => {
                        if(pid !== myId){
                            return { id: pid, ...playerStates[pid] };
                        }
                    }).filter(Boolean),
                    chat: [] 
                }));
            }
            else if(msg.type==="state"){
                if(playerStates[msg.id]){
                    playerStates[msg.id].x = msg.x;
                    playerStates[msg.id].y = msg.y;
                    playerStates[msg.id].color = msg.color;
                }

                broadcast({
                    type: "state",
                    id: msg.id,
                    x: msg.x,
                    y: msg.y,
                    color: msg.color
                }, ws);
            }
            else if(msg.type==="chat"){
                // 2. Sanitize Chat
                const cleanMessage = sanitize(msg.message);
                
                // Get username from trusted server state
                const senderName = playerStates[myId] ? playerStates[myId].username : "Unknown";

                broadcast({ 
                    type:"chat", 
                    username: senderName, 
                    message: cleanMessage 
                });
            }
        } catch(e){
            console.error('bad message', e);
        }
    });

    ws.on('close', () => {
        const id = clients.get(ws);
        const leftUsername = playerStates[id] ? playerStates[id].username : "Unknown";

        clients.delete(ws);
        delete playerStates[id];
        
        if(id) broadcast({ type:"leave", id, username: leftUsername });
    });
});