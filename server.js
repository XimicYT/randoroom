const WebSocket = require('ws');
const Filter = require('bad-words'); 

const port = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port });
console.log('WS relay listening on port', port);

const clients = new Map(); 
const playerStates = {};   
const chatHistory = [];    
const parties = {};        // partyId -> { leaderId, members: [], chatHistory: [] }
const invites = {};        
const inviteCooldowns = {}; 

const MAX_PARTY_SIZE = 10;
const INVITE_COOLDOWN = 15000; 

// ==========================================
// CONFIG
// ==========================================
const filter = new Filter();
filter.addWords('admin', 'mod', 'server'); 

function sanitize(text) {
    if (!text) return "";
    try { return filter.clean(text); } catch (e) { return text; }
}

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

    // --- 1. INVITE ---
    if (command === "invite") {
        if (!arg) return sendTo(playerId, { type: "error", message: "Usage: /party invite [username]" });
        
        let targetId = null;
        for (const pid in playerStates) {
            if (playerStates[pid].username.toLowerCase() === arg.toLowerCase()) {
                targetId = pid;
                break;
            }
        }
        
        if (!targetId) return sendTo(playerId, { type: "error", message: "User not found." });
        if (targetId === playerId) return sendTo(playerId, { type: "error", message: "You cannot invite yourself." });

        const cooldownKey = `${playerId}_${targetId}`;
        const now = Date.now();
        if (inviteCooldowns[cooldownKey] && now - inviteCooldowns[cooldownKey] < INVITE_COOLDOWN) {
            const timeLeft = Math.ceil((INVITE_COOLDOWN - (now - inviteCooldowns[cooldownKey])) / 1000);
            return sendTo(playerId, { type: "error", message: `Wait ${timeLeft}s before inviting them again.` });
        }

        let partyId = pState.partyId;
        if (!partyId) {
            partyId = 'party-' + Math.random().toString(36).substr(2, 9);
            parties[partyId] = { leaderId: playerId, members: [playerId], chatHistory: [] };
            pState.partyId = partyId;
            
            // Broadcast state so borders/tags update
            broadcastState(); 
            sendTo(playerId, { type: "chat", username: "System", message: "Party created.", scope: "party" });
        }

        const party = parties[partyId];
        if (party.leaderId !== playerId) return sendTo(playerId, { type: "error", message: "Only the party leader can invite." });
        if (party.members.length >= MAX_PARTY_SIZE) return sendTo(playerId, { type: "error", message: "Party is full (Max 10)." });
        if (party.members.includes(targetId)) return sendTo(playerId, { type: "error", message: "Player is already in your party." });

        if (!invites[targetId]) invites[targetId] = [];
        invites[targetId].push(partyId);
        inviteCooldowns[cooldownKey] = now; 
        
        sendTo(targetId, { 
            type: "chat", 
            username: "System", 
            message: `<span style="color:#00ff00; font-weight:bold; font-size:14px;">💌 ${pState.username} invited you to a party!</span><br>Type <b>/party accept</b> or <b>/party decline</b>.` 
        });
        sendTo(playerId, { type: "chat", username: "System", message: `Invite sent to ${arg}.`, scope: "party" });
    }

    // --- 2. ACCEPT ---
    else if (command === "accept") {
        if (!invites[playerId] || invites[playerId].length === 0) {
            return sendTo(playerId, { type: "error", message: "No pending invites." });
        }
        
        const targetPartyId = invites[playerId].pop();
        const party = parties[targetPartyId];
        
        if (!party) return sendTo(playerId, { type: "error", message: "Party no longer exists." });
        if (party.members.length >= MAX_PARTY_SIZE) return sendTo(playerId, { type: "error", message: "Party is full." });

        if (pState.partyId) leaveParty(playerId);

        party.members.push(playerId);
        pState.partyId = targetPartyId;

        broadcastState(); 
        sendTo(playerId, { type: "party_history", messages: party.chatHistory });

        party.members.forEach(mid => {
            sendTo(mid, { type: "chat", username: "System", message: `<b>${pState.username}</b> joined the party!`, scope: "party" });
        });
    }

    // --- 3. DECLINE ---
    else if (command === "decline") {
        if (!invites[playerId] || invites[playerId].length === 0) {
            return sendTo(playerId, { type: "error", message: "No invites to decline." });
        }
        invites[playerId].pop(); 
        sendTo(playerId, { type: "chat", username: "System", message: "Invite declined." });
    }

    // --- 4. LEAVE ---
    else if (command === "leave") {
        if (pState.partyId) {
            leaveParty(playerId);
            sendTo(playerId, { type: "chat", username: "System", message: "You left the party." });
        } else {
            sendTo(playerId, { type: "error", message: "You are not in a party." });
        }
    }

    // --- 5. KICK ---
    else if (command === "kick") {
        if (!pState.partyId) return sendTo(playerId, { type: "error", message: "You are not in a party." });
        const party = parties[pState.partyId];
        if (party.leaderId !== playerId) return sendTo(playerId, { type: "error", message: "Only leader can kick." });
        if (!arg) return sendTo(playerId, { type: "error", message: "Usage: /party kick [username]" });

        let targetId = null;
        for (const mid of party.members) {
            if (playerStates[mid].username.toLowerCase() === arg.toLowerCase()) {
                targetId = mid;
                break;
            }
        }

        if (!targetId) return sendTo(playerId, { type: "error", message: "Member not found in party." });
        if (targetId === playerId) return sendTo(playerId, { type: "error", message: "You cannot kick yourself." });

        leaveParty(targetId);
        sendTo(targetId, { type: "chat", username: "System", message: "You were kicked from the party." });
        
        party.members.forEach(mid => {
            sendTo(mid, { type: "chat", username: "System", message: `${arg} was kicked.`, scope: "party" });
        });
    }

    // --- 6. LIST ---
    else if (command === "list") {
        if (!pState.partyId) return sendTo(playerId, { type: "error", message: "You are not in a party." });
        const party = parties[pState.partyId];
        
        let msg = `<b>Party Members (${party.members.length}/10):</b><br>`;
        party.members.forEach(mid => {
            const memberName = playerStates[mid].username;
            const isLeader = (mid === party.leaderId) ? " (Leader)" : "";
            msg += `- ${memberName}${isLeader}<br>`;
        });
        
        sendTo(playerId, { type: "chat", username: "System", message: msg, scope: "party" });
    }

    else {
        sendTo(playerId, { 
            type: "error", 
            message: `Unknown party command: '${command}'. <br>Try: invite, accept, decline, leave, kick, list.` 
        });
    }
}

function leaveParty(playerId) {
    const pState = playerStates[playerId];
    const pid = pState.partyId;
    if (!pid || !parties[pid]) return;

    const party = parties[pid];
    
    // Remove player from array
    party.members = party.members.filter(id => id !== playerId);
    pState.partyId = null;

    sendTo(playerId, { type: "party_clear" });

    // If party is empty, delete it
    if (party.members.length === 0) {
        delete parties[pid];
    } else {
        // LEADERSHIP TRANSFER
        // If the leader left, the new leader is the person at index 0.
        // Since we use push() to add members, index 0 is always the "oldest" member.
        if (party.leaderId === playerId) {
            party.leaderId = party.members[0];
            const newLeaderName = playerStates[party.leaderId].username;
            
            party.members.forEach(mid => {
                sendTo(mid, { type: "chat", username: "System", message: `<b>${newLeaderName}</b> is now the Party Leader.`, scope: "party" });
            });
        }
        
        party.members.forEach(mid => {
            sendTo(mid, { type: "chat", username: "System", message: `${pState.username} left the party.`, scope: "party" });
        });
    }
    
    broadcastState(); // Update visuals immediately
}

// Helper to broadcast state of all players with Leader Flags
function broadcastState() {
    for(const [ws, id] of clients.entries()) {
        if(ws.readyState === WebSocket.OPEN) {
            // We construct the state message individually? No, standard state is fine.
            // But we need to ensure the `isPartyLeader` flag is calculated.
            // Actually, we can just send individual state updates for everyone.
        }
    }
    // Optimization: Just rely on the main loop or force a specific packet?
    // Let's force a state packet for everyone to everyone.
    Object.keys(playerStates).forEach(pid => {
        const p = playerStates[pid];
        let isLeader = false;
        if (p.partyId && parties[p.partyId] && parties[p.partyId].leaderId === pid) {
            isLeader = true;
        }

        const msg = {
            type: "state",
            id: pid,
            x: p.x, y: p.y, color: p.color,
            stamina: p.stamina, isExhausted: p.isExhausted,
            partyId: p.partyId,
            isPartyLeader: isLeader // <--- NEW FLAG
        };
        broadcast(msg);
    });
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
                let cleanUsername = sanitize(msg.username).substring(0, 12).trim() || "Player";
                if(cleanUsername.includes('***')) cleanUsername = "Guest";

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
                        // Calculate leadership for initial load
                        let isL = false;
                        const p = playerStates[pid];
                        if (p.partyId && parties[p.partyId] && parties[p.partyId].leaderId === pid) isL = true;
                        
                        if(pid !== myId) return { id: pid, ...p, isPartyLeader: isL };
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
                // We broadcast this in the loop, but let's do the single broadcast here too
                let isLeader = false;
                if (playerStates[msg.id].partyId && parties[playerStates[msg.id].partyId]) {
                    if (parties[playerStates[msg.id].partyId].leaderId === msg.id) isLeader = true;
                }

                broadcast({
                    type: "state", id: msg.id, x: msg.x, y: msg.y, color: msg.color,
                    stamina: msg.stamina, isExhausted: msg.isExhausted,
                    partyId: playerStates[msg.id].partyId,
                    isPartyLeader: isLeader // <--- Send flag
                }, ws);
            }
            else if(msg.type==="chat"){
                const cleanMessage = sanitize(msg.message);
                const senderName = playerStates[myId] ? playerStates[myId].username : "Unknown";
                const pState = playerStates[myId];

                // COMMANDS
                if (cleanMessage.startsWith('/party')) {
                    const parts = cleanMessage.split(' ');
                    const cmd = parts[1] ? parts[1].toLowerCase() : "";
                    const arg = parts[2] || "";
                    handlePartyCommand(ws, myId, cmd, arg);
                    return; 
                }

                // PARTY CHAT
                if (msg.scope === "party") {
                    if (pState && pState.partyId && parties[pState.partyId]) {
                        
                        const party = parties[pState.partyId];
                        const chatObj = { type: "chat", username: senderName, message: cleanMessage, scope: "party" };
                        party.chatHistory.push(chatObj);
                        if(party.chatHistory.length > 50) party.chatHistory.shift();

                        party.members.forEach(mid => {
                            sendTo(mid, chatObj);
                        });
                    } else {
                        sendTo(myId, { type: "error", message: "You are not in a party. Switch tab to Global." });
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
            leaveParty(id);
            const leftUsername = playerStates[id].username;
            delete playerStates[id];
            broadcast({ type:"leave", id, username: leftUsername });
        }
        clients.delete(ws);
    });
});
