const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

// Find all id="..." in html
const idMatches = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]);
const idSet = new Set(idMatches);
console.log('Total HTML IDs found:', idSet.size);

// Find all getElementById('...') in script
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (scriptMatch) {
  const js = scriptMatch[1];
  const getByIdMatches = [...js.matchAll(/document\.getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  console.log('Total document.getElementById calls in JS:', getByIdMatches.length);
  
  const missing = [];
  getByIdMatches.forEach(id => {
    if (!idSet.has(id)) {
      missing.push(id);
    }
  });

  if (missing.length === 0) {
    console.log('ALL getElementById IDs exist in the HTML!');
  } else {
    console.log('MISSING IDs in HTML:', [...new Set(missing)]);
  }
}
