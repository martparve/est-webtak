import { test, expect } from '@playwright/test';
import { loginViaUi, apiToken, sourceFeatureCount, flyTo, waitForMap } from './helpers.ts';

const GRID_SOURCE = 'cloudtak-mgrs-grid';
const GRID_PREF_KEY = 'cloudtak::grid-enabled';
// Rummu, Estonia
const RUMMU: [number, number] = [24.2, 59.23];

test.describe('TAARA CloudTAK', () => {
    test.beforeEach(async ({ page, request, baseURL }) => {
        // Make sure the profile is in a known state: MGRS coordinates.
        const token = await apiToken(request, baseURL!);
        const res = await request.patch(`${baseURL}/api/profile`, {
            headers: { Authorization: `Bearer ${token}` },
            data: { display_coordinate: 'mgrs' },
        });
        expect(res.ok()).toBeTruthy();

        await loginViaUi(page);
    });

    test('logs in and shows the map with the TAK server link', async ({ page }) => {
        await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
        // The main menu button exists
        await expect(page.getByTitle('Open Menu')).toBeVisible();
    });

    test('Display settings show Coordinate Format and the MGRS Grid toggle', async ({ page }) => {
        await page.goto('/menu/settings/display');
        await waitForMap(page);

        await expect(page.getByText('Coordinate Format')).toBeVisible();
        const gridItem = page.getByTestId('display-mgrs-grid');
        await expect(gridItem).toBeVisible();
        await expect(gridItem.getByText('MGRS Grid')).toBeVisible();

        // Search filters the list but keeps the grid item when it matches
        await page.getByPlaceholder('Search settings...').fill('grid');
        await expect(gridItem).toBeVisible();
        await expect(page.getByText('Coordinate Format')).toHaveCount(0);
    });

    test('grid toggle draws MGRS lines and labels and persists', async ({ page }) => {
        // Zoom 13 gives the 1 km grid: a dozen lines across the view
        await flyTo(page, RUMMU, 13);

        // Start from a known state: grid off
        const toggle = page.getByTestId('map-grid-toggle');
        const initiallyOn = await page.evaluate((k) => localStorage.getItem(k) === '1', GRID_PREF_KEY);
        if (initiallyOn) await toggle.click();
        await expect.poll(() => sourceFeatureCount(page, GRID_SOURCE)).toBe(0);

        await toggle.click();
        await expect(toggle).toHaveAttribute('title', 'Hide MGRS Grid');
        await expect.poll(() => sourceFeatureCount(page, GRID_SOURCE), { timeout: 20_000 }).toBeGreaterThan(10);
        expect(await page.evaluate((k) => localStorage.getItem(k), GRID_PREF_KEY)).toBe('1');

        // Labels: a square id (e.g. "35V LF") and edge values must be present.
        // Poll: querySourceFeatures only sees tiles that have finished loading.
        const labels = () => page.evaluate((id) => {
            const map = (window as unknown as { cloudtakMap: { querySourceFeatures: (s: string) => Array<{ properties: Record<string, string> }> } }).cloudtakMap;
            return map.querySourceFeatures(id).filter((f) => f.properties.kind === 'label').map((f) => `${f.properties.role}:${f.properties.text}`);
        }, GRID_SOURCE);
        await expect.poll(labels, { timeout: 20_000 }).toEqual(expect.arrayContaining([expect.stringMatching(/^square:35V /)]));
        await expect.poll(labels).toEqual(expect.arrayContaining([expect.stringMatching(/^easting:/)]));
        await expect.poll(labels).toEqual(expect.arrayContaining([expect.stringMatching(/^northing:/)]));

        await page.screenshot({ path: 'e2e-results/grid-10km.png' });

        // 100 m grid when zoomed in far
        await flyTo(page, RUMMU, 16.5);
        await expect.poll(() => sourceFeatureCount(page, GRID_SOURCE), { timeout: 20_000 }).toBeGreaterThan(20);
        const fine = () => page.evaluate((id) => {
            const map = (window as unknown as { cloudtakMap: { querySourceFeatures: (s: string) => Array<{ properties: Record<string, string> }> } }).cloudtakMap;
            return map.querySourceFeatures(id).filter((f) => f.properties.role === 'easting').map((f) => f.properties.text);
        }, GRID_SOURCE);
        await expect.poll(fine, { timeout: 20_000 }).not.toHaveLength(0);
        expect((await fine()).every((t) => /^\d{3}$/.test(t))).toBeTruthy();
        await page.screenshot({ path: 'e2e-results/grid-100m.png' });

        // Preference survives a reload
        await page.reload();
        await waitForMap(page);
        await expect(page.getByTestId('map-grid-toggle')).toHaveAttribute('title', 'Hide MGRS Grid');
        await expect.poll(() => sourceFeatureCount(page, GRID_SOURCE), { timeout: 20_000 }).toBeGreaterThan(0);

        // A "1 km scale bar" view still gets the 1 km grid, with two-digit labels
        await flyTo(page, RUMMU, 12.5);
        await expect.poll(() => sourceFeatureCount(page, GRID_SOURCE), { timeout: 20_000 }).toBeGreaterThan(10);
        await expect.poll(labels).toEqual(expect.arrayContaining([expect.stringMatching(/^easting:\d{2}$/)]));
        await page.screenshot({ path: 'e2e-results/grid-1km-wide.png' });

        // Leave it on for the humans
    });

    test('Query Mode opens with MGRS selected', async ({ page }) => {
        // Right-click > Info on the map routes here; go straight to the route.
        await page.goto(`/query/${RUMMU.join(',')}`);
        await waitForMap(page);

        await expect(page.getByText('Query Mode')).toBeVisible();
        const mgrsTab = page.getByRole('menuitem', { name: 'MGRS' });
        await expect(mgrsTab).toBeVisible();
        await expect(mgrsTab).toHaveClass(/text-blue/);
        await expect(page.getByRole('menuitem', { name: 'DD', exact: true })).not.toHaveClass(/text-blue/);
        await page.screenshot({ path: 'e2e-results/query-mode.png' });
    });

    test('grid stays above an opaque raster basemap after switching to Maa-amet ortofoto', async ({ page, request, baseURL }) => {
        // Remember the current basemap so the shared test user is left as found
        const token = await apiToken(request, baseURL!);
        const auth = { headers: { Authorization: `Bearer ${token}` } };
        const overlays = await (await request.get(`${baseURL}/api/profile/overlay`, auth)).json() as { items?: Array<{ mode: string; mode_id: string }> } | Array<{ mode: string; mode_id: string }>;
        const current = (Array.isArray(overlays) ? overlays : overlays.items || []).find((o) => o.mode === 'basemap');
        const originalName = current ? ((await (await request.get(`${baseURL}/api/basemap/${current.mode_id}`, auth)).json()) as { name: string }).name : undefined;

        await flyTo(page, RUMMU, 13);
        const toggle = page.getByTestId('map-grid-toggle');
        if (await page.evaluate((k) => localStorage.getItem(k) !== '1', GRID_PREF_KEY)) await toggle.click();
        await expect.poll(() => sourceFeatureCount(page, GRID_SOURCE), { timeout: 20_000 }).toBeGreaterThan(10);

        const gridAboveRasters = () => page.evaluate((gridId) => {
            const map = (window as unknown as { cloudtakMap: { getStyle: () => { layers: Array<{ id: string; type: string; layout?: { visibility?: string } }> } } }).cloudtakMap;
            const layers = map.getStyle().layers;
            const grid = layers.findIndex((l) => l.id === gridId);
            const rasters = layers.map((l, i) => ({ l, i })).filter(({ l }) => l.type === 'raster' && l.layout?.visibility !== 'none');
            return { grid, rasters: rasters.length, below: rasters.every(({ i }) => i < grid) };
        }, `${GRID_SOURCE}-casing`);

        // Switching replaces the basemap layers asynchronously: wait until a
        // raster layer is back, then it must sit below the grid.
        const rasterBackBelowGrid = async () => {
            const r = await gridAboveRasters();
            return r.rasters > 0 ? r.below : 'no raster layer yet';
        };
        await page.goto('/menu/basemaps');
        await waitForMap(page);
        try {
            await page.getByText('Maa-amet ortofoto').first().click();
            await expect.poll(rasterBackBelowGrid, { timeout: 30_000 }).toBe(true);
            await page.screenshot({ path: 'e2e-results/grid-ortofoto.png' });
        } finally {
            // Put the shared test user's basemap back even when the assertion failed
            if (originalName && originalName !== 'Maa-amet ortofoto') {
                await page.getByText(originalName, { exact: true }).first().click();
                await expect.poll(rasterBackBelowGrid, { timeout: 30_000 }).toBe(true);
            }
        }
    });

    test('Basemaps include Maa-amet ortofoto and OpenTopoMap', async ({ page }) => {
        await page.goto('/menu/basemaps');
        await waitForMap(page);
        await expect(page.getByText('Maa-amet ortofoto')).toBeVisible();
        await expect(page.getByText('OpenTopoMap')).toBeVisible();
    });

    test('Data Sync lists the TAARA missions and opens MUHV-TAARA without errors', async ({ page }) => {
        await page.goto('/menu/missions');
        await waitForMap(page);
        await expect(page.getByText('MUHV-TAARA')).toBeVisible();
        await page.getByText('MUHV-TAARA').first().click();
        await expect(page.getByText('Failed to fetch mission layers')).toHaveCount(0);
        await expect(page.getByText('Generic Error')).toHaveCount(0);
        await expect(page.getByText('Mission Info')).toBeVisible();
    });

    test('an admin user sees the Admin area with the TAK Server Connection page', async ({ page, request, baseURL }) => {
        const token = await apiToken(request, baseURL!);
        const me = await (await request.get(`${baseURL}/api/profile`, { headers: { Authorization: `Bearer ${token}` } })).json() as { system_admin: boolean };
        test.skip(!me.system_admin, 'E2E user is not a system admin');

        await page.goto('/admin');
        await expect(page.getByText('TAK Server Connection', { exact: true })).toBeVisible();
        await page.getByText('TAK Server Connection', { exact: true }).click();
        await expect(page.getByText(/opentakserver/i).first()).toBeVisible();
    });
});
