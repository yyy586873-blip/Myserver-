const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const CALL_FILE = path.join(DATA_DIR, 'calls.json');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR,{recursive:true});
}

if(!fs.existsSync(CALL_FILE)){
    fs.writeFileSync(
        CALL_FILE,
        JSON.stringify([],null,2)
    );
}

app.use(express.json());

function loadCalls(){
    return JSON.parse(
        fs.readFileSync(CALL_FILE,"utf8")
    );
}

function saveCalls(data){
    fs.writeFileSync(
        CALL_FILE,
        JSON.stringify(data,null,2)
    );
}

app.get("/",(req,res)=>{
    res.sendFile(
        path.join(__dirname,"index.html")
    );
});

app.get("/api/history",(req,res)=>{
    res.json(loadCalls());
});

app.post("/api/call",(req,res)=>{

    const from=req.body.from||"Unknown";
    const to=req.body.to||"Unknown";

    let calls=loadCalls();

    const call={

        id:crypto.randomUUID(),
        from:from,
        to:to,
        status:"Incoming",
        time:new Date().toLocaleString()

    };

    calls.unshift(call);

    saveCalls(calls);

    res.json({
        ok:true,
        call
    });

});

app.listen(PORT,"0.0.0.0",()=>{
    console.log("Running "+PORT);
});
