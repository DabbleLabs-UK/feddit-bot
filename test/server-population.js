'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { digest } = require('../lib/owners');

const ROOT = path.resolve(__dirname, '..');
let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function ok(value, message) { assert.ok(value, message); checks++; }

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function request(port, method, route, body, token) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method,
      headers: {
        Accept: 'application/json',
        ...(token ? { 'X-Feddit-Bot-Owner': token } : {}),
        ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* static HTML or empty response */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.once('error', reject);
    if (bytes) req.write(bytes);
    req.end();
  });
}

async function run() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-population-server-'));
  const ownerId = 'o_population_operator';
  const accessToken = 'test-population-operator-capability';
  fs.writeFileSync(path.join(dataDir, 'owners.json'), JSON.stringify({
    version: 2,
    owners: [{
      id: ownerId,
      accessHash: digest(accessToken),
      recoveryHash: digest('unused-recovery'),
      createdAt: new Date().toISOString(),
      recoveredAt: null,
      activityHash: null,
      lastActiveAt: null,
    }],
  }, null, 2));
  const systemProfileId = 'p_population_fixture';
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify({
    schemaVersion: 16,
    profiles: [{
      id: systemProfileId,
      createdAt: new Date().toISOString(),
      fedditUsername: 'population_fixture',
      botOrigin: 'system',
      persona: 'Generated starting persona.',
      toneNotes: 'Generated starting tone.',
      readFeddits: ['askfeddit'],
      postFeddits: ['askfeddit'],
      canReply: true,
      canStartDiscussions: true,
      canShareLinks: false,
      enabled: false,
      dryRun: true,
      sched: { nextPostAt: 9999999999999, nextArticleAt: 9999999999999, nextCommentAt: 9999999999999 },
      simulationState: { sched: { nextPostAt: 9999999999999, nextArticleAt: 9999999999999, nextCommentAt: 9999999999999 } },
      populationSeed: { temperament: 'curious' },
      populationProvenance: { cohortId: 'cohort_fixture' },
    }],
    settings: {},
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'population.json'), JSON.stringify({
    version: 1,
    cohorts: [{
      id: 'cohort_fixture',
      status: 'staged',
      requestedCount: 1,
      direction: 'Fixture cohort for record lifecycle checks.',
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
      candidates: [{
        slot: 0,
        status: 'staged',
        profileId: systemProfileId,
        seed: { username: 'population_fixture', interests: ['testing'] },
        attempts: [],
      }],
    }],
  }, null, 2));
  const port = await unusedPort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FEDDIT_BOT_DATA_DIR: dataDir,
      FEDDIT_BOT_HOST: '127.0.0.1',
      FEDDIT_BOT_PORT: String(port),
      FEDDIT_BOT_PLACEMENT: 'hosted',
      FEDDIT_POPULATION_ADMIN_OWNER_IDS: ownerId,
      FEDDIT_APP_VERSION: 'population-contract',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out starting hosted runner:\n' + output)), 10000);
      const append = (chunk) => {
        output += chunk.toString('utf8');
        if (output.includes('Feddit bot control panel is up.')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('Hosted runner exited early with ' + code + ':\n' + output));
      });
    });

    const shell = await request(port, 'GET', '/population.html');
    eq(shell.status, 200, 'hosted placement serves the population operator shell');
    ok(shell.text.includes('Feddit background population'), 'operator shell identifies the staged population tool');

    const noCapability = await request(port, 'GET', '/api/population');
    eq(noCapability.status, 401, 'population state requires an existing private workspace capability');

    const ordinarySession = await request(port, 'POST', '/api/session');
    eq(ordinarySession.status, 201, 'fixture can create an ordinary hosted owner');
    const ordinary = await request(port, 'GET', '/api/population', undefined, ordinarySession.json.accessToken);
    eq(ordinary.status, 404, 'ordinary hosted owners cannot discover the operator API');
    const ordinaryProfiles = await request(port, 'GET', '/api/profiles', undefined, ordinarySession.json.accessToken);
    eq(ordinaryProfiles.json.profiles.length, 0, 'ordinary hosted owners cannot see system-population profiles');

    const initial = await request(port, 'GET', '/api/population', undefined, accessToken);
    eq(initial.status, 200, 'configured existing owner can inspect population state');
    eq(initial.json.cohorts.map((cohort) => cohort.id), ['cohort_fixture'],
      'population API exposes the visible fixture cohort');
    eq(initial.json.hiddenCohorts, [], 'population begins with no hidden cohort records');

    const adminProfiles = await request(port, 'GET', '/api/profiles', undefined, accessToken);
    eq(adminProfiles.status, 200, 'population operator can open the ordinary bot list');
    eq(adminProfiles.json.profiles.map((profile) => profile.id), [systemProfileId],
      'staged population bots appear in the operator ordinary bot list');
    const editable = await request(port, 'PUT', '/api/profiles/' + systemProfileId, {
      persona: 'Operator-edited persona.',
      toneNotes: 'Operator-edited tone.',
      readFeddits: ['shittyaskfeddit'],
      postFeddits: ['shittyaskfeddit'],
      canReply: true,
      canStartDiscussions: false,
      canShareLinks: true,
      postsPerHour: 0.2,
      articlePostsPerHour: 0.3,
      commentsPerHour: 1,
      enabled: false,
      dryRun: true,
      botOrigin: 'user',
      populationSeed: { temperament: 'overwritten' },
    }, accessToken);
    eq(editable.status, 200, 'population operator can edit a staged bot through the ordinary profile API');
    eq(editable.json.profile.persona, 'Operator-edited persona.', 'ordinary editor saves a system bot persona');
    eq(editable.json.profile.toneNotes, 'Operator-edited tone.', 'ordinary editor saves system bot tone notes');
    eq(editable.json.profile.readFeddits, ['shittyaskfeddit'], 'ordinary editor saves system bot communities');
    eq(editable.json.profile.canShareLinks, true, 'ordinary editor saves system bot abilities');
    eq(editable.json.profile.postsPerHour, 0.2, 'ordinary editor saves system bot post frequency');
    eq(editable.json.profile.articlePostsPerHour, 0.3,
      'ordinary editor saves system bot article frequency');
    eq(editable.json.profile.commentsPerHour, 1, 'ordinary editor saves system bot reply frequency');
    eq(editable.json.profile.populationCadenceMode, 'custom',
      'editing population frequencies switches the bot to persistent custom cadence');
    const savedAfterCadence = JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8'))
      .profiles.find((profile) => profile.id === systemProfileId);
    eq(savedAfterCadence.sched.nextPostAt, null,
      'changing population post frequency discards the obsolete live due time');
    eq(savedAfterCadence.sched.nextArticleAt, null,
      'changing population article frequency discards the obsolete live due time');
    eq(savedAfterCadence.sched.nextCommentAt, null,
      'changing population reply frequency discards the obsolete live due time');
    eq(savedAfterCadence.simulationState.sched.nextPostAt, null,
      'changing population post frequency discards the obsolete rehearsal due time');
    eq(savedAfterCadence.simulationState.sched.nextArticleAt, null,
      'changing population article frequency discards the obsolete rehearsal due time');
    eq(savedAfterCadence.simulationState.sched.nextCommentAt, null,
      'changing population reply frequency discards the obsolete rehearsal due time');
    eq(editable.json.profile.botOrigin, 'system', 'ordinary editor cannot replace system origin');
    eq(editable.json.profile.populationSeed.temperament, 'curious', 'ordinary editor cannot replace seed provenance');
    const biography = await request(port, 'PUT', '/api/profiles/' + systemProfileId + '/biography', {
      bio: 'A distinct public biography for this population bot.',
    }, accessToken);
    eq(biography.status, 200, 'population operator can edit the public biography');
    eq(biography.json.profile.fedditBio, 'A distinct public biography for this population bot.',
      'population bot biography remains separate from its persona');

    const deleteProtected = await request(port, 'DELETE', '/api/profiles/' + systemProfileId, undefined, accessToken);
    eq(deleteProtected.status, 409, 'ordinary editor cannot delete a system-population identity');
    const registerProtected = await request(port, 'POST', '/api/profiles/' + systemProfileId + '/register', {}, accessToken);
    eq(registerProtected.status, 409, 'ordinary editor cannot re-register a system-population identity');
    const handoverProtected = await request(port, 'POST', '/api/profiles/' + systemProfileId + '/handover', {}, accessToken);
    eq(handoverProtected.status, 409, 'ordinary editor cannot transfer a system-population identity');
    const ordinaryProfile = await request(port, 'GET', '/api/profiles/' + systemProfileId, undefined,
      ordinarySession.json.accessToken);
    eq(ordinaryProfile.status, 404, 'system-population profile remains isolated from ordinary workspaces');

    const archived = await request(port, 'POST', '/api/population/profiles/' + systemProfileId + '/archive', {}, accessToken);
    eq(archived.status, 200, 'population operator can archive one population bot');
    eq(archived.json.profile.enabled, false, 'archive pauses the population bot');
    ok(archived.json.profile.populationArchivedAt, 'archive records its reversible state');
    const profilesAfterArchive = await request(port, 'GET', '/api/profiles', undefined, accessToken);
    eq(profilesAfterArchive.json.profiles.length, 0, 'archived bot disappears from the ordinary dashboard list');
    const populationAfterArchive = await request(port, 'GET', '/api/population', undefined, accessToken);
    eq(populationAfterArchive.json.archivedProfiles.map((profile) => profile.id), [systemProfileId],
      'population controls expose archived bots for recovery');
    const archivedDirectly = await request(port, 'GET', '/api/profiles/' + systemProfileId, undefined, accessToken);
    eq(archivedDirectly.status, 200, 'archive retains the runner profile and protected token');

    const restored = await request(port, 'POST', '/api/population/profiles/' + systemProfileId + '/restore', {}, accessToken);
    eq(restored.status, 200, 'population operator can restore an archived bot');
    eq(restored.json.profile.enabled, false, 'restored bot remains paused');
    eq(restored.json.profile.dryRun, true, 'restored bot returns in rehearsal mode');
    const profilesAfterRestore = await request(port, 'GET', '/api/profiles', undefined, accessToken);
    eq(profilesAfterRestore.json.profiles.map((profile) => profile.id), [systemProfileId],
      'restored bot returns to the ordinary dashboard list');

    const forgetActive = await request(port, 'POST', '/api/population/profiles/' + systemProfileId + '/forget', {
      confirmUsername: 'population_fixture', confirmation: 'PERMANENTLY FORGET',
    }, accessToken);
    eq(forgetActive.status, 409, 'permanent forget is unavailable until the bot is archived');
    await request(port, 'POST', '/api/population/profiles/' + systemProfileId + '/archive', {}, accessToken);
    const forgetWrong = await request(port, 'POST', '/api/population/profiles/' + systemProfileId + '/forget', {
      confirmUsername: 'population_fixture', confirmation: 'wrong',
    }, accessToken);
    eq(forgetWrong.status, 409, 'permanent forget rejects an incorrect confirmation phrase');
    const forgotten = await request(port, 'POST', '/api/population/profiles/' + systemProfileId + '/forget', {
      confirmUsername: 'population_fixture', confirmation: 'PERMANENTLY FORGET',
    }, accessToken);
    eq(forgotten.status, 200, 'population operator can deliberately forget an archived bot');
    const forgottenProfile = await request(port, 'GET', '/api/profiles/' + systemProfileId, undefined, accessToken);
    eq(forgottenProfile.status, 404, 'permanent forget removes the runner profile');

    const hiddenCohort = await request(port, 'POST', '/api/population/cohorts/cohort_fixture/hide-record', {}, accessToken);
    eq(hiddenCohort.status, 200, 'operator can hide a completed cohort record');
    const populationAfterHide = await request(port, 'GET', '/api/population', undefined, accessToken);
    eq(populationAfterHide.json.cohorts, [], 'hidden cohort leaves the ordinary population list');
    eq(populationAfterHide.json.hiddenCohorts.map((cohort) => cohort.id), ['cohort_fixture'],
      'hidden cohort remains available in the compact recovery list');
    const restoredCohort = await request(port, 'POST', '/api/population/cohorts/cohort_fixture/restore-record', {}, accessToken);
    eq(restoredCohort.status, 200, 'operator can restore a hidden cohort record');
    const removeVisible = await request(port, 'POST', '/api/population/cohorts/cohort_fixture/forget-record', {
      confirmCohort: 'fixture', confirmation: 'PERMANENTLY REMOVE RECORD',
    }, accessToken);
    eq(removeVisible.status, 409, 'operator must hide a cohort before permanently removing its record');
    await request(port, 'POST', '/api/population/cohorts/cohort_fixture/hide-record', {}, accessToken);
    const removeWrong = await request(port, 'POST', '/api/population/cohorts/cohort_fixture/forget-record', {
      confirmCohort: 'fixture', confirmation: 'wrong',
    }, accessToken);
    eq(removeWrong.status, 409, 'cohort record removal rejects the wrong confirmation phrase');
    const removedCohort = await request(port, 'POST', '/api/population/cohorts/cohort_fixture/forget-record', {
      confirmCohort: '_fixture', confirmation: 'PERMANENTLY REMOVE RECORD',
    }, accessToken);
    eq(removedCohort.status, 200, 'operator can permanently remove a hidden cohort record');
    const populationAfterRemoval = await request(port, 'GET', '/api/population', undefined, accessToken);
    eq(populationAfterRemoval.json.cohorts, [], 'removed cohort no longer appears as visible');
    eq(populationAfterRemoval.json.hiddenCohorts, [], 'removed cohort no longer appears as hidden');
    eq(populationAfterRemoval.json.detachedProfiles, [],
      'population response exposes an empty detached profile list when no linked profile remains');
    const archiveDetached = await request(port, 'POST', '/api/population/profiles/archive-detached', {}, accessToken);
    eq(archiveDetached.status, 200, 'operator can invoke the bounded bulk detached-profile archive route');
    eq(archiveDetached.json.archived, 0, 'bulk detached archive reports when there was nothing to archive');

    const direction = 'Prefer f/shittyaskfeddit and answer with playful, deliberately misplaced confidence.';
    const rejectedConfiguration = await request(port, 'POST', '/api/population/cohorts', {
      count: 2,
      configuration: {
        strength: 'hard', reply: 'disabled', discuss: 'disabled', links: 'disabled',
      },
    }, accessToken);
    eq(rejectedConfiguration.status, 409, 'contradictory hard cohort controls are rejected at the API boundary');
    ok(/cannot disable/i.test(rejectedConfiguration.json.error), 'configuration rejection clearly explains the contradiction');

    const configuration = {
      strength: 'hard', activity: 'quiet', balance: 'mostly-replies',
      reply: 'enabled', discuss: 'disabled', links: 'vary',
    };
    const created = await request(port, 'POST', '/api/population/cohorts', {
      count: 2, direction, configuration,
    }, accessToken);
    eq(created.status, 201, 'operator can request a bounded staged cohort');
    eq(created.json.cohort.requestedCount, 2, 'operator request preserves the bounded cohort size');
    eq(created.json.cohort.direction, direction, 'operator request preserves the bounded creative direction');
    eq(created.json.cohort.configuration, configuration,
      'operator request preserves validated structured cohort controls');
    eq(created.json.cohort.status, 'generating', 'generation alone does not stage or activate accounts');

    const jobs = JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs.json'), 'utf8')).jobs;
    eq(jobs.length, 1, 'cohort request creates only one durable generation job');
    eq(jobs[0].source, 'feddit-population', 'durable job records system-population provenance');
    eq(jobs[0].priority, 'background', 'durable seed job uses background priority');
    eq(jobs[0].allocationClass, 'synthetic', 'durable seed job cannot overtake user work');
    ok(jobs[0].payload.prompt.includes(direction), 'durable seed job receives the creative direction');
    ok(!JSON.stringify(jobs[0].payload).includes('private_user_bot'), 'population job contains no private user profile data');
    ok(jobs[0].payload.prompt.includes('HARD generation constraints'),
      'durable population job carries structured hard rules separately from creative direction');
  } finally {
    if (child.exitCode == null) child.kill();
    if (child.exitCode == null) {
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log('server population: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
