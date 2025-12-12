const WebSocket = require('ws');
const Filter = require('bad-words'); 

const port = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port });
console.log('WS relay listening on port', port);

const clients = new Map(); 
const playerStates = {};   
const chatHistory = [];    
const parties = {}; // partyId -> { leaderId, members: [], chatHistory: [], gameData: null }
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
// PARTY GAME LOGIC
// ==========================================
function handleGameCommand(ws, playerId, command, arg) {
    const pState = playerStates[playerId];
    if (!pState || !pState.partyId) return sendTo(playerId, { type: "error", message: "You must be in a party to play." });
    
    const party = parties[pState.partyId];
    if (!party) return;

    // Only Leader
    if (party.leaderId !== playerId) return sendTo(playerId, { type: "error", message: "Only the Party Leader can control the game." });

    // START INFECTION
    if (command === "infection" && arg === "start") {
        if (party.gameData && party.gameData.active) return sendTo(playerId, { type: "error", message: "Game already in progress." });
        if (party.members.length < 2) return sendTo(playerId, { type: "error", message: "Need at least 2 players in party." });

        // Reset Player States
        party.members.forEach(mid => {
            if (playerStates[mid]) {
                playerStates[mid].isInfected = false;
                playerStates[mid].stamina = 100;
            }
        });

        // Pick Alpha Zombie
        const alphaId = party.members[Math.floor(Math.random() * party.members.length)];
        if (playerStates[alphaId]) playerStates[alphaId].isInfected = true;

        // Init Game Data
        party.gameData = {
            active: true,
            type: 'infection',
            startTime: Date.now(),
            survivors: party.members.filter(id => id !== alphaId),
            infectionLog: [] // To track who lasted longest
        };

        broadcastState(); // Update Visuals
        
        // Announce
        const alphaName = playerStates[alphaId].username;
        party.members.forEach(mid => {
            sendTo(mid, { 
                type: "chat", 
                username: "System", 
                message: `<span style="color:#ff4444; font-weight:bold; font-size:14px;">☣️ INFECTION STARTED!</span><br><b>${alphaName}</b> is the ALPHA! Run!`, 
                scope: "party" 
            });
        });
    }

    // END GAME
    else if (command === "infection" && arg === "end") {
        endPartyGame(party, "Game ended by leader.");
    }
}

function handleTag(attackerId, victimId) {
    const attacker = playerStates[attackerId];
    const victim = playerStates[victimId];

    // Validation
    if (!attacker || !victim) return;
    if (attacker.partyId !== victim.partyId || !attacker.partyId) return; // Must be same party
    
    const party = parties[attacker.partyId];
    if (!party || !party.gameData || !party.gameData.active) return;

    // Logic: Attacker must be infected, Victim must NOT be infected
    if (attacker.isInfected && !victim.isInfected) {
        victim.isInfected = true;
        
        // Log for leaderboard
        party.gameData.infectionLog.push({
            username: victim.username,
            time: Date.now()
        });

        // Remove from survivors list
        party.gameData.survivors = party.gameData.survivors.filter(id => id !== victimId);

        broadcastState(); // Update visuals immediately

        // Announce Tag
        party.members.forEach(mid => {
            sendTo(mid, { 
                type: "chat", 
                username: "System", 
                message: `<span style="color:#ff8800;">${attacker.username} infected ${victim.username}!</span>`, 
                scope: "party" 
            });
        });

        // Check Win Condition (0 Survivors)
        if (party.gameData.survivors.length === 0) {
            endPartyGame(party, "Everyone has been infected!");
        }
    }
}

function endPartyGame(party, reasonMsg) {
    if (!party.gameData || !party.gameData.active) return;

    // Calculate Results
    const log = party.gameData.infectionLog;
    let winnerMsg = "<br><b>Survival Ranking:</b><br>";
    
    if (log.length > 0) {
        // The last person added to the log lasted the longest among the infected
        // But if someone was never infected (impossible if game ends naturally), they win.
        // Since game ends when survivor count is 0, the last person infected is the winner.
        const winner = log[log.length - 1];
        const duration = ((winner.time - party.gameData.startTime) / 1000).toFixed(1);
        winnerMsg += `🏆 <b>${winner.username}</b> lasted ${duration}s!`;
    } else {
        winnerMsg += "No one survived long enough.";
    }

    party.members.forEach(mid => {
        // Reset State
        if (playerStates[mid]) playerStates[mid].isInfected = false;
        
        sendTo(mid, { 
            type: "chat", 
            username: "System", 
            message: `<span style="color:#00ff00; font-weight:bold;">GAME OVER</span><br>${reasonMsg}${winnerMsg}`, 
            scope: "party" 
        });
    });

    party.gameData = null; // Clear game data
    broadcastState();
}

// ==========================================
// PARTY MANAGEMENT
// ==========================================
function handlePartyCommand(ws, playerId, command, arg) {
    // ... (Keep the previous Party Logic for Invite/Kick/etc) ...
    // Note: I will copy the previous logic here but integrate the game checks
    const pState = playerStates[playerId];
    if (!pState) return;

    if (command === "invite") {
        if (!arg) return sendTo(playerId, { type: "error", message: "Usage: /party invite [username]" });
        let targetId = null;
        for (const pid in playerStates) {
            if (playerStates[pid].username.toLowerCase() === arg.toLowerCase()) { targetId = pid; break; }
        }
        if (!targetId) return sendTo(playerId, { type: "error", message: "User not found." });
        if (targetId === playerId) return sendTo(playerId, { type: "error", message: "Cannot invite self." });

        // Cooldown check...
        const cooldownKey = `${playerId}_${targetId}`;
        const now = Date.now();
        if (inviteCooldowns[cooldownKey] && now - inviteCooldowns[cooldownKey] < INVITE_COOLDOWN) {
            return sendTo(playerId, { type: "error", message: "Wait before inviting again." });
        }

        let partyId = pState.partyId;
        if (!partyId) {
            partyId = 'party-' + Math.random().toString(36).substr(2, 9);
            parties[partyId] = { leaderId: playerId, members: [playerId], chatHistory: [], gameData: null };
            pState.partyId = partyId;
            broadcastState();
            sendTo(playerId, { type: "chat", username: "System", message: "Party created.", scope: "party" });
        }

        const party = parties[partyId];
        if (party.leaderId !== playerId) return sendTo(playerId, { type: "error", message: "Only leader can invite." });
        if (party.members.length >= MAX_PARTY_SIZE) return sendTo(playerId, { type: "error", message: "Party full." });
        // Can't invite during active game
        if (party.gameData && party.gameData.active) return sendTo(playerId, { type: "error", message: "Cannot invite during active game." });

        if (!invites[targetId]) invites[targetId] = [];
        invites[targetId].push(partyId);
        inviteCooldowns[cooldownKey] = now;
        
        sendTo(targetId, { type: "chat", username: "System", message: `<span style="color:#00ff00;">💌 ${pState.username} invited you to a party!</span>`, scope: "local" });
        sendTo(playerId, { type: "chat", username: "System", message: `Invite sent to ${arg}.`, scope: "party" });
    }
    else if (command === "accept") {
        if (!invites[playerId] || invites[playerId].length === 0) return sendTo(playerId, { type: "error", message: "No invites." });
        const targetPartyId = invites[playerId].pop();
        const party = parties[targetPartyId];
        if (!party) return sendTo(playerId, { type: "error", message: "Party gone." });
        if (party.members.length >= MAX_PARTY_SIZE) return sendTo(playerId, { type: "error", message: "Party full." });
        if (party.gameData && party.gameData.active) return sendTo(playerId, { type: "error", message: "Party is currently playing a game." });

        if (pState.partyId) leaveParty(playerId);
        party.members.push(playerId);
        pState.partyId = targetPartyId;
        broadcastState();
        sendTo(playerId, { type: "party_history", messages: party.chatHistory });
        party.members.forEach(mid => sendTo(mid, { type: "chat", username: "System", message: `<b>${pState.username}</b> joined!`, scope: "party" }));
    }
    else if (command === "decline") {
        if (!invites[playerId] || invites[playerId].length === 0) return sendTo(playerId, { type: "error", message: "No invites." });
        invites[playerId].pop();
        sendTo(playerId, { type: "chat", username: "System", message: "Declined." });
    }
    else if (command === "leave") {
        if (pState.partyId) leaveParty(playerId);
        else sendTo(playerId, { type: "error", message: "Not in a party." });
    }
    else if (command === "kick") {
        if (!pState.partyId) return sendTo(playerId, { type: "error", message: "Not in party." });
        const party = parties[pState.partyId];
        if (party.leaderId !== playerId) return sendTo(playerId, { type: "error", message: "Only leader can kick." });
        
        let targetId = null;
        for (const mid of party.members) {
            if (playerStates[mid].username.toLowerCase() === arg.toLowerCase()) { targetId = mid; break; }
        }
        if (!targetId) return sendTo(playerId, { type: "error", message: "Member not found." });
        if (targetId === playerId) return sendTo(playerId, { type: "error", message: "Cannot kick self." });

        leaveParty(targetId);
        sendTo(targetId, { type: "chat", username: "System", message: "You were kicked." });
        party.members.forEach(mid => sendTo(mid, { type: "chat", username: "System", message: `${arg} was kicked.`, scope: "party" }));
    }
    else if (command === "list") {
        if (!pState.partyId) return sendTo(playerId, { type: "error", message: "Not in party." });
        const party = parties[pState.partyId];
        let msg = `<b>Members (${party.members.length}/10):</b><br>`;
        party.members.forEach(mid => {
            const m = playerStates[mid];
            msg += `- ${m.username} ${mid === party.leaderId ? "(Leader)" : ""} ${m.isInfected ? "<b>[INFECTED]</b>" : ""}<br>`;
        });
        sendTo(playerId, { type: "chat", username: "System", message: msg, scope: "party" });
    }
    else {
        sendTo(playerId, { type: "error", message: "Unknown party command." });
    }
}

function leaveParty(playerId) {
    const pState = playerStates[playerId];
    const pid = pState.partyId;
    if (!pid || !parties[pid]) return;

    const party = parties[pid];
    party.members = party.members.filter(id => id !== playerId);
    pState.partyId = null;
    pState.isInfected = false; // Reset game status on leave

    sendTo(playerId, { type: "party_clear" });
    broadcastState();

    // Check if game needs to end because of leaver
    if (party.gameData && party.gameData.active) {
        party.gameData.survivors = party.gameData.survivors.filter(id => id !== playerId);
        if (party.gameData.survivors.length === 0 && party.members.length > 1) {
            endPartyGame(party, "The last survivor left the party!");
        } else if (party.members.length < 2) {
            endPartyGame(party, "Not enough players left.");
        }
    }

    if (party.members.length === 0) {
        delete parties[pid];
    } else {
        if (party.leaderId === playerId) {
            party.leaderId = party.members[0];
            const newLeaderName = playerStates[party.leaderId].username;
            party.members.forEach(mid => sendTo(mid, { type: "chat", username: "System", message: `${newLeaderName} is now Leader.`, scope: "party" }));
        }
        party.members.forEach(mid => sendTo(mid, { type: "chat", username: "System", message: `${pState.username} left.`, scope: "party" }));
    }
}

function broadcastState() {
    Object.keys(playerStates).forEach(pid => {
        const p = playerStates[pid];
        let isLeader = false;
        if (p.partyId && parties[p.partyId] && parties[p.partyId].leaderId === pid) isLeader = true;

        const msg = {
            type: "state",
            id: pid,
            x: p.x, y: p.y, color: p.color,
            stamina: p.stamina, isExhausted: p.isExhausted,
            partyId: p.partyId,
            isPartyLeader: isLeader,
            isInfected: p.isInfected // Broadcast infection status
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
                let cleanUsername = sanitize(msg.username).substring(0, 14).trim() || "Player";
                if(cleanUsername.includes('***')) cleanUsername = "Guest";

                const isTaken = Object.values(playerStates).some(p => p.username.toLowerCase() === cleanUsername.toLowerCase());
                if (isTaken) { ws.send(JSON.stringify({ type: "error", message: "Username taken." })); return; }

                myId = msg.id;
                clients.set(ws, myId);

                playerStates[myId] = { 
                    x: msg.x, y: msg.y, color: msg.color, username: cleanUsername,
                    stamina: 100, isExhausted: false, partyId: null, isInfected: false
                };

                broadcast({ type: "join", id: myId, x: msg.x, y: msg.y, color: msg.color, username: cleanUsername }, ws);

                ws.send(JSON.stringify({
                    type: "welcome", id: myId,
                    peers: Object.keys(playerStates).map(pid => {
                        let isL = false;
                        const p = playerStates[pid];
                        if (p.partyId && parties[p.partyId] && parties[p.partyId].leaderId === pid) isL = true;
                        if(pid !== myId) return { id: pid, ...p, isPartyLeader: isL };
                    }).filter(Boolean),
                    chat: chatHistory
                }));
            }
            else if(msg.type==="state"){
                // We rely on server-side logic for game state updates now, 
                // client only sends position/stamina
                if(playerStates[msg.id]){
                    playerStates[msg.id].x = msg.x;
                    playerStates[msg.id].y = msg.y;
                    playerStates[msg.id].color = msg.color;
                    playerStates[msg.id].stamina = msg.stamina;
                    playerStates[msg.id].isExhausted = msg.isExhausted;
                }
                broadcastState(); // This is heavier but ensures consistency for party tags
            }
            else if(msg.type==="tag") {
                // Client claiming they tagged someone
                handleTag(myId, msg.targetId);
            }
            else if(msg.type==="chat"){
                const cleanMessage = sanitize(msg.message);
                
                // COMMANDS
                if (cleanMessage.startsWith('/party')) {
                    const parts = cleanMessage.split(' ');
                    const cmd = parts[1] ? parts[1].toLowerCase() : "";
                    const arg = parts[2] || "";
                    handlePartyCommand(ws, myId, cmd, arg);
                    return; 
                }
                if (cleanMessage.startsWith('/game')) {
                    const parts = cleanMessage.split(' ');
                    const cmd = parts[1] ? parts[1].toLowerCase() : "";
                    const arg = parts[2] || "";
                    handleGameCommand(ws, myId, cmd, arg);
                    return;
                }

                // CHAT
                const senderName = playerStates[myId].username;
                if (msg.scope === "party") {
                    const pState = playerStates[myId];
                    if (pState && pState.partyId && parties[pState.partyId]) {
                        const party = parties[pState.partyId];
                        const chatObj = { type: "chat", username: senderName, message: cleanMessage, scope: "party" };
                        party.chatHistory.push(chatObj);
                        if(party.chatHistory.length > 50) party.chatHistory.shift();
                        party.members.forEach(mid => sendTo(mid, chatObj));
                    } else {
                        sendTo(myId, { type: "error", message: "Not in a party." });
                    }
                } 
                else {
                    const chatObj = { username: senderName, message: cleanMessage, scope: "public" };
                    chatHistory.push(chatObj);
                    if(chatHistory.length > 50) chatHistory.shift();
                    broadcast({ type:"chat", username: senderName, message: cleanMessage, scope: "public" });
                }
            }
        } catch(e){ console.error(e); }
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

setInterval(() => {
    const now = Date.now();
    for (const key in inviteCooldowns) {
        if (now - inviteCooldowns[key] > INVITE_COOLDOWN) delete inviteCooldowns[key];
    }
}, 60000);
