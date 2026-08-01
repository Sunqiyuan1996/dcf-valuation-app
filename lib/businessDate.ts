/** Latest US market business date; weekends deliberately retain Friday. */
export function latestBusinessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const date = new Date(`${get('year')}-${get('month')}-${get('day')}T12:00:00Z`);
  const weekday = get('weekday');
  if (weekday === 'Sat') date.setUTCDate(date.getUTCDate() - 1);
  if (weekday === 'Sun') date.setUTCDate(date.getUTCDate() - 2);
  return date.toISOString().slice(0, 10);
}
