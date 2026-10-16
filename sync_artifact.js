const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const artifactPath = 'C:\\Users\\97798\\.gemini\\antigravity\\brain\\98607a2b-f8f4-44a9-a760-188a23522fda\\rate_engine_app.html';

const updated = src.split("fetch('/api/").join("fetch((window.location.origin.startsWith('http') ? '' : 'http://localhost:8080') + '/api/");

fs.writeFileSync(artifactPath, updated, 'utf8');
console.log('Synchronized artifact rate_engine_app.html successfully!');
