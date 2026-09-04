const fs = require('fs');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const md = fs.readFileSync(__dirname + '/PRD-MVP.md', 'utf8');
const children = [];
for (const line of md.split(/\r?\n/)) {
  if (!line.trim()) { children.push(new Paragraph({ text: '' })); continue; }
  if (line.startsWith('# ')) children.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.TITLE }));
  else if (line.startsWith('## ')) children.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_1 }));
  else if (line.startsWith('### ')) children.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_2 }));
  else if (line.startsWith('- ')) children.push(new Paragraph({ text: line.slice(2), bullet: { level: 0 } }));
  else if (line.startsWith('```')) continue;
  else if (line.startsWith('|')) children.push(new Paragraph({ children: [new TextRun({ text: line.replace(/\|/g, '  ').trim(), font: 'Arial' })] }));
  else children.push(new Paragraph({ children: [new TextRun({ text: line.replace(/\*\*/g, ''), font: 'Arial' })] }));
}
const doc = new Document({ sections: [{ properties: {}, children }] });
Packer.toBuffer(doc).then(buf => fs.writeFileSync(__dirname + '/MVP-PRD.docx', buf));
