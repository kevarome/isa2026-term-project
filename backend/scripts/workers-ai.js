export const cloudflareApi = 'https://api.cloudflare.com/client/v4';

export function createWorkersAi(account, getToken) {
  return {
    async run(model, input) {
      const native = model.startsWith('@cf/');
      const path = native ? `/ai/run/${model}` : '/ai/run';
      const signal = AbortSignal.timeout(12000);
      const response = await fetch(`${cloudflareApi}/accounts/${account}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(native ? input : { model, input }),
        signal
      });
      if (!response.ok) throw new Error(`Workers AI HTTP ${response.status}`);
      const data = await response.json();
      if (data.success === false) throw new Error('Workers AI reported a failure.');
      return data.result ?? data;
    }
  };
}
