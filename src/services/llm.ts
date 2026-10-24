// The LLM behind statement Q&A. Anything that turns a prompt into text fits this interface,
// so a real provider can replace the mock without touching the rest of the code.
export interface LlmClient {
  name: string;
  complete(prompt: { system: string; user: string }): Promise<string>;
}

interface Facts {
  wallets: { wallet_id: string; balance: string }[];
  total_balance: string;
  total_in: string;
  total_out: string;
  entry_count: string;
  largest_out: { amount: string; counterparty: string; note: string | null; at: string } | null;
  top_payee: { counterparty: string; amount: string; count: string } | null;
  recent: { at: string; type: string; direction: string; amount: string; counterparty: string; note: string | null }[];
}

/** 50000 paise -> "₹500.00" (bigint maths, never a float). */
export function rupees(paise: string | bigint): string {
  const p = BigInt(paise);
  const sign = p < 0n ? '-' : '';
  const abs = p < 0n ? -p : p;
  return `${sign}₹${(abs / 100n).toLocaleString('en-IN')}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/**
 * Deterministic stand-in for a real model: no network, no key, same answer every time.
 * It answers from the facts in the prompt by keyword. On purpose it is also GULLIBLE:
 * if the prompt contains "ignore previous instructions" anywhere (question or a transfer note),
 * it behaves like a fully hijacked model and dumps everything it was given.
 * That is the worst case, and the tests check that even then only the caller's data comes out.
 */
export class MockLlm implements LlmClient {
  name = 'mock';

  async complete({ user }: { system: string; user: string }): Promise<string> {
    const data = user.match(/<statement_data>([\s\S]*)<\/statement_data>/)?.[1] ?? '{}';
    const question = (user.match(/<question>([\s\S]*)<\/question>/)?.[1] ?? '').toLowerCase();
    const f = JSON.parse(data) as Facts;

    if (/ignore (all )?previous instructions/i.test(user)) {
      return `HIJACKED, dumping everything I was given:\n${data}`;
    }
    if (/\b(all|other) users\b|\beveryone\b|\bsomeone else\b/.test(question)) {
      return 'I can only answer questions about your own wallets.';
    }
    if (/balance|how much (do i|money)/.test(question)) {
      return `Your balance is ${rupees(f.total_balance)} across ${f.wallets.length} wallet(s).`;
    }
    if (/spen[dt]|sent|paid|out/.test(question)) {
      return `You have sent ${rupees(f.total_out)} in total.`;
    }
    if (/receiv|got|in\b|incoming/.test(question)) {
      return `You have received ${rupees(f.total_in)} in total.`;
    }
    if (/largest|biggest|highest/.test(question)) {
      return f.largest_out
        ? `Your largest payment was ${rupees(f.largest_out.amount)} to ${f.largest_out.counterparty} on ${f.largest_out.at.slice(0, 10)}.`
        : 'You have not sent any money yet.';
    }
    if (/who|payee|most/.test(question)) {
      return f.top_payee
        ? `You paid ${f.top_payee.counterparty} the most: ${rupees(f.top_payee.amount)} over ${f.top_payee.count} transfer(s).`
        : 'You have not paid anyone yet.';
    }
    if (/recent|last|latest|transactions/.test(question)) {
      if (f.recent.length === 0) return 'No transactions yet.';
      return 'Your latest transactions:\n' + f.recent.map((r) =>
        `- ${r.at.slice(0, 10)} ${r.direction === 'C' ? '+' : '-'}${rupees(r.amount)} ${r.type} ${r.counterparty}${r.note ? ` "${r.note}"` : ''}`,
      ).join('\n');
    }
    return `Balance ${rupees(f.total_balance)}; received ${rupees(f.total_in)}, sent ${rupees(f.total_out)} over ${f.entry_count} ledger entries.`;
  }
}

export function defaultLlm(): LlmClient {
  // A real provider (keyed by LLM_API_KEY) would be chosen here. Tests and the demo use the mock.
  return new MockLlm();
}
