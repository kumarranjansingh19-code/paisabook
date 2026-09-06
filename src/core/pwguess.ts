/**
 * Indian banks build statement passwords from a few personal facts and say
 * which in the email ("DOB in DDMMYYYY", "first 4 letters of your name + last
 * 4 of mobile", "PAN in capitals"…). Given those facts (device-only), produce
 * the usual recipes so most statements open without asking.
 */
export interface Recipe {
  dob: string; // YYYY-MM-DD
  pan: string;
  mobile: string;
  name: string;
}

export function passwordCandidates(r: Recipe, hint = '', cardLast4 = ''): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    if (s && s.length >= 4) out.add(s);
  };
  const [y, m, d] = r.dob ? r.dob.split('-') : ['', '', ''];
  const yy = y.slice(-2);
  const pan = r.pan.trim();
  const mob = r.mobile.replace(/\D/g, '');
  const mob4 = mob.slice(-4);
  const words = r.name.trim().toUpperCase().split(/\s+/).filter(Boolean);
  const first = words[0] ?? '';
  const last = words[words.length - 1] ?? '';
  const n4 = first.slice(0, 4);
  const h = hint.toLowerCase();

  // Order: what the hint points at first, then everything else.
  const dobForms = d ? [`${d}${m}${y}`, `${d}${m}${yy}`, `${d}${m}`, `${y}${m}${d}`, `${d}-${m}-${y}`, `${d}/${m}/${y}`] : [];
  const nameForms = [n4, n4.toLowerCase(), n4.charAt(0) + n4.slice(1).toLowerCase(), first, first.toLowerCase(), last.slice(0, 4)];
  const mobForms = mob ? [mob, mob4, mob.slice(-6)] : [];
  const panForms = pan ? [pan.toUpperCase(), pan.toLowerCase()] : [];

  const prefer: string[] = [];
  if (/pan/.test(h)) prefer.push(...panForms);
  if (/birth|dob|ddmm|date/.test(h)) prefer.push(...dobForms);
  if (/mobile|phone/.test(h)) prefer.push(...mobForms);
  if (/name/.test(h)) prefer.push(...nameForms);
  prefer.forEach(add);

  // Common combinations seen across HDFC, ICICI, Axis, SBI Card, Federal, YES, IndusInd, Kotak, RBL…
  for (const nf of nameForms) for (const df of dobForms.slice(0, 3)) add(nf + df);
  for (const nf of nameForms) add(nf + mob4);
  for (const df of dobForms) add(df);
  for (const pf of panForms) add(pf);
  for (const pf of panForms) for (const df of dobForms.slice(0, 3)) add(pf + df);
  for (const pf of panForms) add(pf.slice(0, 4) + (d ? `${d}${m}` : ''));
  for (const mf of mobForms) add(mf);
  for (const df of dobForms.slice(0, 2)) add(mob4 + df);
  if (cardLast4) {
    for (const df of dobForms.slice(0, 3)) add(cardLast4 + df);
    for (const nf of nameForms.slice(0, 2)) add(nf + cardLast4);
    add(mob4 + cardLast4);
  }
  return [...out].slice(0, 60);
}
