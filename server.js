const WebSocket = require('ws');
const Filter = require('bad-words'); 

const port = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port });
console.log('WS relay listening on port', port);

const clients = new Map(); // ws -> id
const playerStates = {};   // id -> {x, y, color, username, stamina, isExhausted, partyId}
const chatHistory = [];    
const parties = {};        // partyId -> { leaderId, members: [id] }
const invites = {};        // targetId -> [partyId]

// ==========================================
// CENSORSHIP
// ==========================================
const filter = new Filter();
filter.addWords('admin', 'mod', 'server'); 

function sanitize(text) {
    if (!text) return "";
    try { return filter.clean(text); } catch (e) { return text; }
}

// ==========================================
// BROADCAST HELPERS
// ==========================================
function broadcast(msg, except=null){
    const raw = JSON.stringify(msg);
    for(const client of wss.clients){
        if(client.readyState===WebSocket.OPEN && client!==except){
            client.send(raw);
        }
    }
}

function sendTo(playerId, msg) {
    for(const [ws, id] of clients.entries()) {
        if(id === playerId && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
            return;
        }
    }
}

// ==========================================
// PARTY LOGIC
// ==========================================
function handlePartyCommand(ws, playerId, command, arg) {
    const pState = playerStates[playerId];
    if (!pState) return;

    // 1. CREATE / INVITE
    if (command === "invite") {
        if (!arg) return sendTo(playerId, { type: "error", message: "Usage: /party invite [username]" });
        
        // Find target
        let targetId = null;
        for (const pid in playerStates) {
            if (playerStates[pid].username.toLowerCase() === arg.toLowerCase()) {
                targetId = pid;
                break;
            }
        }
        if (!targetId) return sendTo(playerId, { type: "error", message: "User not found." });
        if (targetId === playerId) return sendTo(playerId, { type: "error", message: "You cannot invite yourself." });

        // Create party if not exists
        let partyId = pState.partyId;
        if (!partyId) {
            partyId = 'party-' + Math.random().toString(36).substr(2, 9);
            parties[partyId] = { leaderId: playerId, members: [playerId] };
            pState.partyId = partyId;
            // Notify creator
            sendTo(playerId, { type: "chat", username: "System", message: "Party created.", scope: "party" });
        }

        // Check if leader
        if (parties[partyId].leaderId !== playerId) {
            return sendTo(playerId, { type: "error", message: "Only the party leader can invite." });
        }

        // Send Invite
        if (!invites[targetId]) invites[targetId] = [];
        invites[targetId].push(partyId);
        
        sendTo(targetId, { 
            type: "chat", 
            username: "System", 
            message: `<b>${pState.username}</b> invited you to a party. Type <b>/party accept</b> to join.` 
        });
        sendTo(playerId, { type: "chat", username: "System", message: `Invite sent to ${arg}.`, scope: "party" });
    }

    // 2. ACCEPT
    else if (command === "accept") {
        if (!invites[playerId] || invites[playerId].length === 0) {
            return sendTo(playerId, { type: "error", message: "No pending invites." });
        }
        
        const targetPartyId = invites[playerId].pop(); // Get last invite
        const party = parties[targetPartyId];
        
        if (!party) return sendTo(playerId, { type: "error", message: "Party no longer exists." });

        // Leave current party if in one
        if (pState.partyId) leaveParty(playerId);

        // Join new
        party.members.push(playerId);
        pState.partyId = targetPartyId;

        // Notify Party
        party.members.forEach(mid => {
            sendTo(mid, { type: "chat", username: "System", message: `${pState.username} has joined the party!`, scope: "party" });
        });
    }

    // 3. LEAVE
    else if (command === "leave") {
        if (pState.partyId) {
            leaveParty(playerId);
            sendTo(playerId, { type: "chat", username: "System", message: "You left the party." });
        } else {
            sendTo(playerId, { type: "error", message: "You are not in a party." });
        }
    }

    // 4. KICK
    else if (command === "kick") {
        if (!pState.partyId) return sendTo(playerId, { type: "error", message: "You are not in a party." });
        const party = parties[pState.partyId];
        if (party.leaderId !== playerId) return sendTo(playerId, { type: "error", message: "Only leader can kick." });

        // Find target ID by name
        let targetId = null;
        for (const mid of party.members) {
            if (playerStates[mid].username.toLowerCase() === arg.toLowerCase()) {
                targetId = mid;
                break;
            }
        }

        if (!targetId) return sendTo(playerId, { type: "error", message: "Member not found in party." });
        if (targetId === playerId) return sendTo(playerId, { type: "error", message: "Use /party leave to leave." });

        leaveParty(targetId);
        sendTo(targetId, { type: "chat", username: "System", message: "You were kicked from the party." });
        
        party.members.forEach(mid => {
            sendTo(mid, { type: "chat", username: "System", message: `${arg} was kicked.`, scope: "party" });
        });
    }
}

function leaveParty(playerId) {
    const pState = playerStates[playerId];
    const pid = pState.partyId;
    if (!pid || !parties[pid]) return;

    const party = parties[pid];
    party.members = party.members.filter(id => id !== playerId);
    pState.partyId = null;

    // If empty, delete
    if (party.members.length === 0) {
        delete parties[pid];
    } else {
        // If leader left, assign new leader
        if (party.leaderId === playerId) {
            party.leaderId = party.members[0];
            const newLeaderName = playerStates[party.leaderId].username;
            party.members.forEach(mid => {
                sendTo(mid, { type: "chat", username: "System", message: `${newLeaderName} is now the leader.`, scope: "party" });
            });
        }
        // Notify others
        party.members.forEach(mid => {
            sendTo(mid, { type: "chat", username: "System", message: `${pState.username} left the party.`, scope: "party" });
        });
    }
}

// ==========================================
// WEBSOCKET
// ==========================================
wss.on('connection', ws => {
    let myId = null;

    ws.on('message', data => {
        try{
            const msg = JSON.parse(data);

            if(msg.type==="join"){
                // Sanitize
                let cleanUsername = sanitize(msg.username).substring(0, 12).trim() || "Player";
                if(cleanUsername.includes('***')) cleanUsername = "Guest";

                // Duplicate Check
                const isTaken = Object.values(playerStates).some(p => 
                    p.username.toLowerCase() === cleanUsername.toLowerCase()
                );
                if (isTaken) {
                    ws.send(JSON.stringify({ type: "error", message: "Username is already taken." }));
                    return; 
                }

                myId = msg.id;
                clients.set(ws, myId);

                playerStates[myId] = { 
                    x: msg.x, y: msg.y, color: msg.color, username: cleanUsername,
                    stamina: 100, isExhausted: false, partyId: null
                };

                broadcast({
                    type: "join", id: myId, x: msg.x, y: msg.y, color: msg.color, username: cleanUsername
                }, ws);

                ws.send(JSON.stringify({
                    type: "welcome", id: myId,
                    peers: Object.keys(playerStates).map(pid => {
                        if(pid !== myId) return { id: pid, ...playerStates[pid] };
                    }).filter(Boolean),
                    chat: chatHistory
                }));
            }
            else if(msg.type==="state"){
                if(playerStates[msg.id]){
                    playerStates[msg.id].x = msg.x;
                    playerStates[msg.id].y = msg.y;
                    playerStates[msg.id].color = msg.color;
                    playerStates[msg.id].stamina = msg.stamina;
                    playerStates[msg.id].isExhausted = msg.isExhausted;
                }

                broadcast({
                    type: "state", id: msg.id, x: msg.x, y: msg.y, color: msg.color,
                    stamina: msg.stamina, isExhausted: msg.isExhausted,
                    partyId: playerStates[msg.id].partyId // Broadcast party ID so clients know who is in party
                }, ws);
            }
            else if(msg.type==="chat"){
                const cleanMessage = sanitize(msg.message);
                const senderName = playerStates[myId] ? playerStates[myId].username : "Unknown";
                const pState = playerStates[myId];

                // CHECK FOR COMMANDS
                if (cleanMessage.startsWith('/party')) {
                    const parts = cleanMessage.split(' ');
                    const cmd = parts[1] ? parts[1].toLowerCase() : "";
                    const arg = parts[2] || "";
                    handlePartyCommand(ws, myId, cmd, arg);
                    return; // Don't broadcast command
                }

                // CHECK FOR PARTY CHAT
                if (msg.scope === "party") {
                    if (pState && pState.partyId && parties[pState.partyId]) {
                        // Only send to members
                        parties[pState.partyId].members.forEach(mid => {
                            sendTo(mid, { 
                                type:"chat", 
                                username: senderName, 
                                message: cleanMessage,
                                scope: "party"
                            });
                        });
                    } else {
                        sendTo(myId, { type: "error", message: "You are not in a party." });
                    }
                } 
                // PUBLIC CHAT
                else {
                    const chatObject = { username: senderName, message: cleanMessage, scope: "public" };
                    chatHistory.push(chatObject);
                    if(chatHistory.length > 50) chatHistory.shift();
                    broadcast({ type:"chat", username: senderName, message: cleanMessage, scope: "public" });
                }
            }
        } catch(e){
            console.error('bad message', e);
        }
    });

    ws.on('close', () => {
        const id = clients.get(ws);
        if (id && playerStates[id]) {
            // Handle leaving party on disconnect
            leaveParty(id);
            const leftUsername = playerStates[id].username;
            delete playerStates[id];
            broadcast({ type:"leave", id, username: leftUsername });
        }
        clients.delete(ws);
    });
});
