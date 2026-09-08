function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
}

export function renderMatrixSvg(workspace, patientName = "患者") {
  const colors = { story: "#58B98A", factor: "#63A8D8", lifestyle: "#E2A34D" };
  const sections = workspace?.sections || [];
  const cardWidth = 480, cardHeight = 250, gapX = 28, gapY = 28, margin = 55;
  const output = [`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1250" viewBox="0 0 1600 1250"><rect width="1600" height="1250" fill="#F7FAF8"/><text x="55" y="70" font-size="30" font-family="Noto Sans SC, sans-serif" font-weight="700" fill="#17231F">功能医学矩阵</text><text x="55" y="105" font-size="16" font-family="Noto Sans SC, sans-serif" fill="#71807A">${escapeXml(patientName)} · 截图识别候选 · 人工核对版本</text>`];
  sections.forEach((section, index) => {
    const column = index % 3, row = Math.floor(index / 3), x = margin + column * (cardWidth + gapX), y = 145 + row * (cardHeight + gapY), color = colors[section.kind] || colors.factor;
    output.push(`<rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="18" fill="#FFFFFF" stroke="#DDE8E1" stroke-width="2"/><rect x="${x}" y="${y}" width="${cardWidth}" height="8" rx="4" fill="${color}"/><text x="${x + 24}" y="${y + 43}" font-size="22" font-family="Noto Sans SC, sans-serif" font-weight="700" fill="#17231F">${String(index + 1).padStart(2, "0")} ${escapeXml(section.title)}</text><rect x="${x + 350}" y="${y + 22}" width="105" height="28" rx="14" fill="#EFF5F1"/><text x="${x + 402}" y="${y + 41}" text-anchor="middle" font-size="13" font-family="Noto Sans SC, sans-serif" fill="#557065">${escapeXml(section.reviewStatus || "待审核")}</text>`);
    const facts = (section.confirmedFacts?.length ? section.confirmedFacts : section.candidateFacts || []).slice(0, 4);
    facts.forEach((fact, factIndex) => output.push(`<circle cx="${x + 31}" cy="${y + 78 + factIndex * 31}" r="4" fill="${color}"/><text x="${x + 45}" y="${y + 83 + factIndex * 31}" font-size="15" font-family="Noto Sans SC, sans-serif" fill="#52645A">${escapeXml(String(fact.text || "").slice(0, 34))}</text>`));
    if (!facts.length) output.push(`<text x="${x + 24}" y="${y + 90}" font-size="15" font-family="Noto Sans SC, sans-serif" fill="#A0ADA5">待从截图或文字稿补充</text>`);
    output.push(`<text x="${x + 24}" y="${y + 218}" font-size="13" font-family="Noto Sans SC, sans-serif" fill="#88978F">候选事实：${(section.candidateFacts || []).length} 条 · 来源可追溯</text>`);
  });
  return output.join("") + "</svg>";
}
