/*
 WORLD CHAT v2 - dependency-free Node.js
 Render Start Command: node server.js

 IMPORTANT:
 - Messages are kept only in RAM for SYNC_BUFFER_LIMIT messages.
 - They are NOT written to disk/database.
 - Restart/redeploy clears the temporary sync buffer.
 - Files are temporary and expire automatically.
 - Set ADMIN_TOKEN in Render Environment Variables.
*/

var http = require("http");
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var PORT = parseInt(process.env.PORT || "10000", 10);
var HOST = "0.0.0.0";

var ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "");
var INDEX_FILE = path.join(__dirname, "index.html");
var ADMIN_FILE = path.join(__dirname, "admin.html");

var clients = [];
var recentMessages = [];
var tempFiles = Object.create(null);

var SYNC_BUFFER_LIMIT = parseInt(process.env.SYNC_BUFFER_LIMIT || "100", 10);
var FILE_TTL_MS = parseInt(process.env.FILE_TTL_MS || String(30 * 60 * 1000), 10);
var MAX_UPLOAD = parseInt(process.env.MAX_UPLOAD || String(100 * 1024 * 1024), 10);

var MESSAGE_ENABLED = String(process.env.MESSAGE_ENABLED || "true").toLowerCase() !== "false";
var ATTACHMENT_ENABLED = String(process.env.ATTACHMENT_ENABLED || "true").toLowerCase() !== "false";
var MESSAGE_COOLDOWN_MS = Math.max(0, parseInt(process.env.MESSAGE_COOLDOWN_MS || "0", 10));

var globalNotice = "";

function makeId() {
    return crypto.randomBytes(16).toString("hex");
}

function sendHttp(res, code, type, body, extra) {
    var data = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    var headers = {
        "Content-Type": type,
        "Content-Length": data.length,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    };
    if (extra) {
        Object.keys(extra).forEach(function(k) { headers[k] = extra[k]; });
    }
    res.writeHead(code, headers);
    res.end(data);
}

function sendJson(res, code, obj) {
    sendHttp(res, code, "application/json; charset=utf-8", JSON.stringify(obj));
}

function cleanName(name) {
    name = String(name || "file.bin").replace(/[^a-zA-Z0-9._-]/g, "_");
    return name.substring(0, 100) || "file.bin";
}

function removeClient(c) {
    var i = clients.indexOf(c);
    if (i >= 0) clients.splice(i, 1);
}

function wsFrame(opcode, payload) {
    payload = payload || Buffer.alloc(0);
    var len = payload.length, head;
    if (len <= 125) {
        head = Buffer.from([0x80 | opcode, len]);
    } else if (len <= 65535) {
        head = Buffer.alloc(4);
        head[0] = 0x80 | opcode; head[1] = 126;
        head.writeUInt16BE(len, 2);
    } else {
        head = Buffer.alloc(10);
        head[0] = 0x80 | opcode; head[1] = 127;
        head.writeUInt32BE(Math.floor(len / 4294967296), 2);
        head.writeUInt32BE(len >>> 0, 6);
    }
    return Buffer.concat([head, payload]);
}

function send(c, obj) {
    if (!c || c.socket.destroyed) return false;
    try {
        c.socket.write(wsFrame(1, Buffer.from(JSON.stringify(obj), "utf8")));
        return true;
    } catch (e) { return false; }
}

function broadcast(obj) {
    var dead = [];
    for (var i=0;i<clients.length;i++) if (!send(clients[i], obj)) dead.push(clients[i]);
    for (var j=0;j<dead.length;j++) removeClient(dead[j]);
}

function sendPresence() {
    broadcast({type:"presence", online:clients.length, serverTime:Date.now()});
}

function addRecent(message) {
    recentMessages.push(message);
    while (recentMessages.length > SYNC_BUFFER_LIMIT) recentMessages.shift();
}

function userCooldown(c) {
    if (!MESSAGE_COOLDOWN_MS) return false;
    return Date.now() - (c.lastMessageAt || 0) < MESSAGE_COOLDOWN_MS;
}

function protocolClose(c) {
    try { c.socket.write(wsFrame(8, Buffer.from([3,234]))); } catch(e) {}
    try { c.socket.end(); } catch(e2) {}
}

function handleMessage(c, data) {
    if (!data || typeof data.type !== "string") return;

    if (data.type === "hello") {
        c.userId = String(data.userId || "").substring(0,100);
        c.name = String(data.name || "User").substring(0,40);

        send(c, {
            type:"ready",
            online:clients.length,
            serverTime:Date.now(),
            settings:{
                messageEnabled:MESSAGE_ENABLED,
                attachmentEnabled:ATTACHMENT_ENABLED,
                cooldownMs:MESSAGE_COOLDOWN_MS
            },
            notice:globalNotice
        });

        if (recentMessages.length) {
            send(c, {
                type:"history_sync",
                messages:recentMessages,
                count:recentMessages.length
            });
        }

        sendPresence();
        return;
    }

    if (data.type === "message") {
        if (!MESSAGE_ENABLED && String(data.senderId || "") !== "ADMIN") {
            send(c,{type:"error",code:"MESSAGES_DISABLED",message:"Messages are currently disabled."});
            return;
        }

        if (userCooldown(c)) {
            send(c,{type:"error",code:"MESSAGE_COOLDOWN",message:"Please wait before sending another message.",remainingMs:MESSAGE_COOLDOWN_MS-(Date.now()-c.lastMessageAt)});
            return;
        }

        c.lastMessageAt=Date.now();

        var admin = c.isAdmin === true;
        var message = {
            type:"message",
            messageId:String(data.messageId || makeId()),
            senderId:admin ? "ADMIN" : String(data.senderId || c.userId || ""),
            senderName:admin ? "ADMIN" : String(data.senderName || c.name || "User").substring(0,40),
            role:admin ? "admin" : "user",
            messageType:"text",
            text:String(data.text || "").substring(0,4000),
            timestamp:Date.now()
        };

        addRecent(message);
        broadcast(message);
        return;
    }

    if (data.type === "admin_message") {
        if (!c.isAdmin) {
            send(c,{type:"error",code:"ADMIN_ONLY",message:"Admin access required."});
            return;
        }

        var adminMessage = {
            type:"message",
            messageId:makeId(),
            senderId:"ADMIN",
            senderName:"ADMIN",
            role:"admin",
            messageType:"text",
            text:String(data.text || "").substring(0,4000),
            timestamp:Date.now()
        };

        addRecent(adminMessage);
        broadcast(adminMessage);
        return;
    }
}

function parseFrames(c) {
    while (c.buffer.length >= 2) {
        var b0=c.buffer[0], b1=c.buffer[1];
        var fin=(b0&0x80)!==0, opcode=b0&15, masked=(b1&0x80)!==0;
        var len=b1&127, offset=2;

        if (!masked) { protocolClose(c); return; }

        if (len===126) {
            if(c.buffer.length<4)return;
            len=c.buffer.readUInt16BE(2); offset=4;
        } else if(len===127) {
            if(c.buffer.length<10)return;
            var high=c.buffer.readUInt32BE(2), low=c.buffer.readUInt32BE(6);
            if(high!==0){protocolClose(c);return;}
            len=low;offset=10;
        }

        if(len>1024*1024){protocolClose(c);return;}
        if(c.buffer.length<offset+4+len)return;

        var mask=c.buffer.slice(offset,offset+4); offset+=4;
        var enc=c.buffer.slice(offset,offset+len);
        var payload=Buffer.alloc(len);
        for(var i=0;i<len;i++)payload[i]=enc[i]^mask[i%4];
        c.buffer=c.buffer.slice(offset+len);

        if(opcode===8){try{c.socket.write(wsFrame(8));}catch(e){} try{c.socket.end();}catch(e2){} return;}
        if(opcode===9){try{c.socket.write(wsFrame(10,payload));}catch(e3){} continue;}
        if(opcode!==1){continue;}
        if(!fin){continue;}

        var data;
        try{data=JSON.parse(payload.toString("utf8"));}catch(e4){send(c,{type:"error",code:"BAD_JSON",message:"Invalid JSON"});continue;}
        handleMessage(c,data);
    }
}

function websocketUpgrade(req,socket) {
    var key=req.headers["sec-websocket-key"];
    if(!key){socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");return;}

    var accept=crypto.createHash("sha1").update(key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+accept+"\r\n\r\n");

    var c={socket:socket,buffer:Buffer.alloc(0),userId:"",name:"User",isAdmin:false,lastMessageAt:0};
    clients.push(c);
    socket.setNoDelay(true);

    send(c,{type:"connected",serverTime:Date.now()});

    socket.on("data",function(chunk){
        c.buffer=Buffer.concat([c.buffer,chunk]);
        try{parseFrames(c);}catch(e){protocolClose(c);}
    });
    socket.on("close",function(){removeClient(c);sendPresence();});
    socket.on("end",function(){removeClient(c);sendPresence();});
    socket.on("error",function(){removeClient(c);});
}

function adminAuthorized(req) {
    if (!ADMIN_TOKEN) return false;
    var token=String(req.headers["x-admin-token"] || "");
    return token === ADMIN_TOKEN;
}

function cleanupFiles() {
    var now=Date.now();
    Object.keys(tempFiles).forEach(function(id){
        var f=tempFiles[id];
        if(!f || f.expires<=now){
            if(f)try{fs.unlinkSync(f.path);}catch(e){}
            delete tempFiles[id];
        }
    });
}

setInterval(cleanupFiles,60000);

var server=http.createServer(function(req,res){
    var u=new URL(req.url,"http://localhost");

    if(req.method==="OPTIONS"){sendHttp(res,204,"text/plain","");return;}

    if(req.method==="GET" && (u.pathname==="/" || u.pathname==="/index.html")){
        fs.readFile(INDEX_FILE,function(err,data){
            if(err){sendHttp(res,500,"text/plain","index.html missing");return;}
            sendHttp(res,200,"text/html; charset=utf-8",data,{"ETag":crypto.createHash("md5").update(data).digest("hex")});
        });
        return;
    }

    if(req.method==="GET" && u.pathname==="/admin.html"){
        fs.readFile(ADMIN_FILE,function(err,data){
            if(err){sendHttp(res,500,"text/plain","admin.html missing");return;}
            sendHttp(res,200,"text/html; charset=utf-8",data);
        });
        return;
    }

    if(req.method==="GET" && u.pathname==="/health"){
        sendJson(res,200,{ok:true,online:clients.length,settings:{messageEnabled:MESSAGE_ENABLED,attachmentEnabled:ATTACHMENT_ENABLED,cooldownMs:MESSAGE_COOLDOWN_MS},serverTime:Date.now()});
        return;
    }

    if(req.method==="POST" && u.pathname==="/admin/settings"){
        if(!adminAuthorized(req)){sendJson(res,401,{ok:false,error:"UNAUTHORIZED"});return;}

        var body="";
        req.on("data",function(chunk){body+=chunk.toString("utf8");if(body.length>20000)req.destroy();});
        req.on("end",function(){
            var d;
            try{d=JSON.parse(body);}catch(e){sendJson(res,400,{ok:false,error:"BAD_JSON"});return;}

            if(typeof d.messageEnabled==="boolean")MESSAGE_ENABLED=d.messageEnabled;
            if(typeof d.attachmentEnabled==="boolean")ATTACHMENT_ENABLED=d.attachmentEnabled;
            if(d.cooldownMs!=null)MESSAGE_COOLDOWN_MS=Math.max(0,parseInt(d.cooldownMs,10)||0);
            if(typeof d.notice==="string")globalNotice=d.notice.substring(0,500);

            broadcast({type:"settings",settings:{messageEnabled:MESSAGE_ENABLED,attachmentEnabled:ATTACHMENT_ENABLED,cooldownMs:MESSAGE_COOLDOWN_MS},notice:globalNotice});
            sendJson(res,200,{ok:true,settings:{messageEnabled:MESSAGE_ENABLED,attachmentEnabled:ATTACHMENT_ENABLED,cooldownMs:MESSAGE_COOLDOWN_MS},notice:globalNotice});
        });
        return;
    }

    if(req.method==="POST" && u.pathname==="/admin/message"){
        if(!adminAuthorized(req)){sendJson(res,401,{ok:false,error:"UNAUTHORIZED"});return;}
        var body2="";
        req.on("data",function(chunk){body2+=chunk.toString("utf8");});
        req.on("end",function(){
            var d2;
            try{d2=JSON.parse(body2);}catch(e2){sendJson(res,400,{ok:false,error:"BAD_JSON"});return;}
            var m={type:"message",messageId:makeId(),senderId:"ADMIN",senderName:"ADMIN",role:"admin",messageType:"text",text:String(d2.text||"").substring(0,4000),timestamp:Date.now()};
            addRecent(m);broadcast(m);sendJson(res,200,{ok:true,message:m});
        });
        return;
    }

    if(req.method==="POST" && u.pathname==="/admin/clear-history"){
        if(!adminAuthorized(req)){sendJson(res,401,{ok:false,error:"UNAUTHORIZED"});return;}
        recentMessages=[];
        broadcast({type:"history_cleared"});
        sendJson(res,200,{ok:true});
        return;
    }

    if(req.method==="POST" && u.pathname==="/upload"){
        if(!ATTACHMENT_ENABLED){sendJson(res,403,{ok:false,error:"ATTACHMENTS_DISABLED"});return;}

        var id=makeId(),name=cleanName(u.searchParams.get("name")),mime=String(u.searchParams.get("mime")||"application/octet-stream").substring(0,120);
        var filePath=path.join(__dirname,".worldchat_"+id+"_"+name);
        var out=fs.createWriteStream(filePath),total=0,failed=false;

        req.on("data",function(chunk){
            if(failed)return;
            total+=chunk.length;
            if(total>MAX_UPLOAD){
                failed=true;try{out.destroy();fs.unlinkSync(filePath);}catch(e){}
                return;
            }
            out.write(chunk);
        });
        req.on("end",function(){
            if(failed){sendJson(res,413,{ok:false,error:"FILE_TOO_LARGE"});return;}
            out.end(function(){
                tempFiles[id]={path:filePath,name:name,mime:mime,size:total,expires:Date.now()+FILE_TTL_MS};
                sendJson(res,200,{ok:true,fileId:id,fileName:name,mime:mime,size:total});
            });
        });
        req.on("error",function(){failed=true;try{out.destroy();fs.unlinkSync(filePath);}catch(e){}});
        return;
    }

    if(req.method==="GET" && u.pathname.indexOf("/file/")===0){
        var fid=u.pathname.substring(6),f=tempFiles[fid];
        if(!f||f.expires<=Date.now()||!fs.existsSync(f.path)){sendHttp(res,404,"text/plain","File expired or not found");return;}
        res.writeHead(200,{"Content-Type":f.mime,"Content-Length":f.size,"Cache-Control":"no-store","Access-Control-Allow-Origin":"*","Content-Disposition":'inline; filename="'+f.name.replace(/"/g,"")+'"'});
        fs.createReadStream(f.path).pipe(res);
        return;
    }

    sendHttp(res,404,"text/plain","Not found");
});

server.on("upgrade",function(req,socket){
    var u=new URL(req.url,"http://localhost");
    if(u.pathname!=="/ws"){socket.end("HTTP/1.1 404 Not Found\r\n\r\n");return;}
    websocketUpgrade(req,socket);
});

server.listen(PORT,HOST,function(){console.log("World Chat v2 on "+HOST+":"+PORT);});

setInterval(function(){
    for(var i=clients.length-1;i>=0;i--){
        if(clients[i].socket.destroyed){removeClient(clients[i]);continue;}
        try{clients[i].socket.write(wsFrame(9,Buffer.from("ping")));}catch(e){removeClient(clients[i]);}
    }
},25000);
