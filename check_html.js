const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Extract only HTML tags
const tagRegex = /<\/?([a-zA-Z0-9\-]+)(?:\s+[^>]*?)?(\/?)>/g;
const stack = [];
let match;

let line = 1;
let lastIndex = 0;

while ((match = tagRegex.exec(html)) !== null) {
  const fullTag = match[0];
  const tagName = match[1].toLowerCase();
  const isSelfClosing = match[2] === '/' || voidTags.has(tagName) || ['path', 'circle', 'rect', 'line', 'polygon', 'polyline'].includes(tagName);
  const isClosing = fullTag.startsWith('</');

  // Count lines
  const textBefore = html.slice(lastIndex, match.index);
  line += (textBefore.match(/\n/g) || []).length;
  lastIndex = match.index;

  // Skip tags inside <script> or <style>
  if (stack.length > 0 && (stack[stack.length - 1].tag === 'script' || stack[stack.length - 1].tag === 'style')) {
    if (isClosing && tagName === stack[stack.length - 1].tag) {
      stack.pop();
    }
    continue;
  }

  if (tagName === 'script' || tagName === 'style') {
    if (!isClosing && !isSelfClosing) {
      stack.push({ tag: tagName, line });
    }
    continue;
  }

  if (isSelfClosing && !isClosing) {
    continue;
  }

  if (isClosing) {
    if (stack.length === 0) {
      console.log(`Extra closing tag </${tagName}> at line ${line}`);
    } else {
      const top = stack.pop();
      if (top.tag !== tagName) {
        console.log(`Mismatch at line ${line}: expected </${top.tag}> (from line ${top.line}), but found </${tagName}>`);
      }
    }
  } else {
    stack.push({ tag: tagName, line });
  }
}

console.log('Total unclosed tags remaining:', stack.length);
stack.forEach(s => console.log(`Unclosed <${s.tag}> opened at line ${s.line}`));
