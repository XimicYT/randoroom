const WebSocket = require('ws');
const Filter = require('bad-words'); 

const port = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port });
console.log('WS relay listening on port', port);

const clients = new Map(); // ws -> id
const playerStates = {};   // id -> {x, y, color, username}
const chatHistory = [];    

// ==========================================
// CENSORSHIP CONFIGURATION
// ==========================================
const filter = new Filter();
filter.addWords('admin', 'mod', 'server'); 

function sanitize(text) {
    if (!text) return "";
    try {
        return filter.clean(text); 
    } catch (e) {
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
                // 1. Sanitize Username
                let cleanUsername = sanitize(msg.username).substring(0, 12).trim() || "Player";
                if(cleanUsername.includes('***')) cleanUsername = "Guest";

                // 2. CHECK FOR DUPLICATES (NEW LOGIC)
                const isTaken = Object.values(playerStates).some(p => 
                    p.username.toLowerCase() === cleanUsername.toLowerCase()
                );

                if (isTaken) {
                    // Send error specifically to this user
                    ws.send(JSON.stringify({ 
                        type: "error", 
                        message: "Username is already taken." 
                    }));
                    return; // STOP EXECUTION HERE. Do not let them join.
                }

                // If we get here, the name is valid
                myId = msg.id;
                clients.set(ws, myId);

                playerStates[myId] = { 
                    x: msg.x, 
                    y: msg.y, 
                    color: msg.color,
                    username: cleanUsername 
                };

                // Broadcast Join
                broadcast({
                    type: "join",
                    id: myId,
                    x: msg.x,
                    y: msg.y,
                    color: msg.color,
                    username: cleanUsername
                }, ws);

                // Send Welcome
                ws.send(JSON.stringify({
                    type: "welcome",
                    id: myId,
                    peers: Object.keys(playerStates).map(pid => {
                        if(pid !== myId){
                            return { id: pid, ...playerStates[pid] };
                        }
                    }).filter(Boolean),
                    chat: chatHistory
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
                const cleanMessage = sanitize(msg.message);
                const senderName = playerStates[myId] ? playerStates[myId].username : "Unknown";

                const chatObject = { username: senderName, message: cleanMessage };
                
                chatHistory.push(chatObject);
                if(chatHistory.length > 50) chatHistory.shift();

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
        // Only broadcast leave if they actually finished joining (id exists)
        if (id && playerStates[id]) {
            const leftUsername = playerStates[id].username;
            delete playerStates[id];
            broadcast({ type:"leave", id, username: leftUsername });
        }
        clients.delete(ws);
    });
});
