import { test, expect } from '@playwright/test';
import { loginViaUi, waitForMap, apiToken } from './helpers';

/**
 * A point added to the MUHV-TAARA Data Sync from CloudTAK must land on the
 * TAK server's mission (and from there on every subscribed ATAK).
 * Set E2E_KEEP=1 to leave the marker in place for a manual check on a phone.
 */
const MISSION = 'MUHV-TAARA';
const CALLSIGN = `CLOUDTAK-SYNC-${new Date().toISOString().slice(11, 16).replace(':', '')}`;

test('a point shared to MUHV-TAARA from CloudTAK reaches the TAK server mission', async ({ page, request, baseURL }) => {
    test.setTimeout(180_000);
    await loginViaUi(page);

    // OTS only lets a client subscribe once it knows the client's UID, and it
    // learns it from a position report. Set a manual location first so the
    // self CoT carries real coordinates, then give the 5 s reporter time.
    await page.evaluate(async () => {
        const root = document.querySelector('#app') as unknown as { __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, unknown> } } } } };
        const store = root.__vue_app__.config.globalProperties.$pinia._s.get('cloudtak') as { worker: { profile: { update: (p: unknown) => Promise<unknown> } } };
        await store.worker.profile.update({ tak_loc: { type: 'Point', coordinates: [26.72, 58.38] } });
    });
    await page.waitForTimeout(12_000);

    await page.goto('/menu/missions');
    await waitForMap(page);
    await page.getByText(MISSION).first().click();
    await expect(page.getByText('Mission Info')).toBeVisible();

    const subscribe = page.getByRole('button', { name: 'Subscribe', exact: true });
    if (await subscribe.isVisible().catch(() => false)) {
        await subscribe.click();
        await expect(page.getByRole('button', { name: 'Unsubscribe' })).toBeVisible({ timeout: 30_000 });
    }

    const token = await apiToken(request, baseURL!);
    const auth = { Authorization: `Bearer ${token}` };
    const missions = await (await request.get(`${baseURL}/api/marti/mission?passwordProtected=true&defaultRole=true`, { headers: auth })).json() as { items: Array<{ name: string; guid: string }> };
    const mission = missions.items.find((m) => m.name === MISSION);
    expect(mission, `${MISSION} listed`).toBeTruthy();

    const id = crypto.randomUUID();
    const now = new Date();
    const feat = {
        id,
        type: 'Feature',
        origin: { mode: 'Mission', mode_id: mission!.guid },
        properties: {
            id,
            type: 'a-f-G',
            how: 'h-g-i-g-o',
            archived: true,
            callsign: CALLSIGN,
            remarks: 'Sync test from CloudTAK, safe to delete',
            time: now.toISOString(),
            start: now.toISOString(),
            stale: new Date(now.getTime() + 365 * 86400_000).toISOString(),
            center: [26.72, 58.38],
        },
        geometry: { type: 'Point', coordinates: [26.72, 58.38] },
    };

    // Same path the Share panel's "Data Syncs" tab uses (Share.vue): an
    // authored add with a Mission origin publishes the CoT to that mission.
    await page.evaluate(async (f) => {
        const root = document.querySelector('#app') as unknown as { __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, unknown> } } } } };
        const store = root.__vue_app__.config.globalProperties.$pinia._s.get('cloudtak') as { worker: { db: { add: (f: unknown, o: unknown) => Promise<unknown> } } };
        await store.worker.db.add(f, { authored: true });
    }, feat);

    await expect.poll(async () => {
        const res = await request.get(`${baseURL}/api/marti/missions/${mission!.guid}/cot`, { headers: auth });
        const body = await res.json() as { features?: Array<{ id: string; properties: { callsign: string } }> };
        return (body.features || []).some((c) => c.id === id || c.properties.callsign === CALLSIGN);
    }, { timeout: 60_000, intervals: [2000] }).toBe(true);

    console.log(`marker ${CALLSIGN} (${id}) is on the server mission`);

    if (process.env.E2E_KEEP !== '1') {
        const del = await request.delete(`${baseURL}/api/marti/missions/${mission!.guid}/cot/${id}`, { headers: auth });
        expect(del.ok(), `cleanup delete: ${del.status()}`).toBeTruthy();
    }
});
