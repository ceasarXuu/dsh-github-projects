import assert from 'node:assert/strict'
import test from 'node:test'
import { expectErrorJson, expectJson, fixtureRun, startApp } from './support.mjs'

const target = { workspaceId: 'sidebar', owner: 'octocat', number: 4 }
const project = { ...target, title: 'Work', id: 'PVT_sample', url: 'https://github.com/users/octocat/projects/4' }

function ghJson(data) {
  return { stdout: JSON.stringify(data) }
}

async function setup(t, config, runner = fixtureRun) {
  const app = startApp({ config, runner })
  t.after(() => app.dispose())
  expectJson(await app.post('/bind-workspace', { workspaceId: target.workspaceId, project }))
  return app
}

test('sidebar refuses GitHub mutations while the existing write gate is off', async (t) => {
  const app = await setup(t, { allowWrites: false })
  expectErrorJson(await app.post('/project-operation', { ...target, action: 'create-issue' }), 403, 'writes-disabled')
})

test('sidebar reads saved views in GitHub order and passes the filter as a string', async (t) => {
  const filter = 'status:"In Progress" assignee:@me'
  const app = await setup(t, {}, (args, input) => {
    if (!input) return fixtureRun(args)
    const { query, variables } = JSON.parse(input)
    if (query.includes('query SidebarLayout')) {
      return ghJson({ data: { repositoryOwner: { projectV2: {
        ...project, viewerCanUpdate: true, fields: { nodes: [] },
        views: { nodes: [
          { id: 'PVTV_board', number: 2, name: 'Board', layout: 'BOARD_LAYOUT', filter },
          { id: 'PVTV_table', number: 1, name: 'Backlog', layout: 'TABLE_LAYOUT', filter: '' },
        ] },
      } } } })
    }
    assert.match(query, /query SidebarItems/)
    assert.equal(variables.filter, filter)
    return ghJson({ data: { repositoryOwner: { projectV2: { items: { totalCount: 0, nodes: [], pageInfo: {} } } } } })
  })
  const layout = expectJson(await app.get('/project-layout?workspaceId=sidebar&owner=octocat&number=4'))
  assert.deepEqual(layout.views.map(({ name }) => name), ['Board', 'Backlog'])
  const rows = expectJson(await app.get(`/project-view-items?workspaceId=sidebar&owner=octocat&number=4&filter=${encodeURIComponent(filter)}`))
  assert.deepEqual(rows.items, [])
})

test('creating an Issue exposes an add-only retry when GitHub rejects adding it', async (t) => {
  let creations = 0
  let additions = 0
  const app = await setup(t, { allowWrites: true }, (args, input) => {
    if (!input && args[1] === 'repos/octocat/tools/issues/17') return ghJson({ node_id: 'I_sample', number: 17 })
    if (!input) return fixtureRun(args)
    const payload = JSON.parse(input)
    if (args[1] !== 'graphql') {
      assert.deepEqual(args, ['api', 'repos/octocat/tools/issues', '--method', 'POST', '--input', '-'])
      assert.equal(payload.title, '@literal GitHub title')
      creations += 1
      return ghJson({ node_id: 'I_sample', number: 17, html_url: 'https://github.com/octocat/tools/issues/17', title: payload.title })
    }
    if (payload.query.includes('query SidebarLayout')) {
      return ghJson({ data: { repositoryOwner: { projectV2: { ...project, viewerCanUpdate: true } } } })
    }
    assert.match(payload.query, /addProjectV2ItemById/)
    assert.equal(payload.variables.input.contentId, 'I_sample')
    additions += 1
    if (additions === 1) return ghJson({ errors: [{ message: 'temporarily unavailable' }] })
    return ghJson({ data: { addProjectV2ItemById: { item: { id: 'PVTI_sample' } } } })
  })
  const created = expectJson(await app.post('/project-operation', {
    ...target, action: 'create-issue', repo: 'octocat/tools', title: '@literal GitHub title', body: '',
  }))
  assert.equal(created.issue.number, 17)
  assert.equal(created.retry.action, 'add-item')
  const joined = expectJson(await app.post('/project-operation', { ...target, ...created.retry }))
  assert.equal(joined.itemId, 'PVTI_sample')
  assert.equal(creations, 1)
  assert.equal(additions, 2)
})
