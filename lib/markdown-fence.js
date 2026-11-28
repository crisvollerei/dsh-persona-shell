// CommonMark permits up to three spaces before a fence. Only a backtick
// fence forbids another backtick in the info string.
export function openingFence(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return;
  return match[1];
}

export function closesFence(line, opening) {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line);
  return !!match && match[1][0] === opening[0] && match[1].length >= opening.length;
}
