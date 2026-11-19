const FIELD_ID = '... on ProjectV2FieldCommon { id }'
const FIELD = `... on ProjectV2FieldCommon { id name dataType isIssueField }
  ... on ProjectV2SingleSelectField { options { id name color } }
  ... on ProjectV2MultiSelectField { multiOptions:multiSelectOptions { id name color } }
  ... on ProjectV2IterationField { configuration { iterations { id title } completedIterations { id title } } }`

const LAYOUT = `query SidebarLayout($owner:String!,$number:Int!){
  repositoryOwner(login:$owner){ ... on ProjectV2Owner { projectV2(number:$number){
    id title url viewerCanUpdate
    repositories(first:25){ nodes{ nameWithOwner } }
    fields(first:50){ nodes{ ${FIELD} } pageInfo{hasNextPage} }
    views(first:50,orderBy:{field:POSITION,direction:ASC}){ pageInfo{hasNextPage} nodes{
      id number name layout filter
      fields(first:50){ nodes{ ${FIELD_ID} } }
      verticalGroupByFields(first:10){ nodes{ ${FIELD_ID} } }
      groupByFields(first:10){ nodes{ ${FIELD_ID} } }
      sortByFields(first:10){ nodes{ direction field{ ${FIELD_ID} } } }
    } }
  } } }
}`

const VALUES = `fieldValues(first:50){ pageInfo{hasNextPage} nodes{
  ... on ProjectV2ItemFieldValueCommon { field{ ${FIELD_ID} } }
  ... on ProjectV2ItemFieldSingleSelectValue { optionId name }
  ... on ProjectV2ItemFieldMultiSelectValue { choices:options{ id name } }
  ... on ProjectV2ItemFieldIterationValue { iterationId iterationTitle:title }
  ... on ProjectV2ItemFieldTextValue { text }
  ... on ProjectV2ItemFieldNumberValue { number }
  ... on ProjectV2ItemFieldDateValue { date }
} }`

const contentFields = (limit) => `number title url state repository { nameWithOwner }
  labels(first:${limit}){ totalCount nodes{ name } } assignees(first:${limit}){ totalCount nodes{ login } } milestone{ number title }`

const ITEMS = `query SidebarItems($owner:String!,$number:Int!,$filter:String!,$limit:Int!,$cursor:String){
  repositoryOwner(login:$owner){ ... on ProjectV2Owner { projectV2(number:$number){
    items(first:$limit,after:$cursor,query:$filter,archivedStates:[NOT_ARCHIVED]){
      totalCount pageInfo{hasNextPage endCursor} nodes{
        id ${VALUES} content{ __typename
          ... on Issue{ ${contentFields(12)} }
          ... on PullRequest{ ${contentFields(12)} }
          ... on DraftIssue{ title assignees(first:30){nodes{login}} }
        }
      }
    }
  } } }
}`

const COMMENTS = `comments(last:$maxComments) @include(if:$withComments) { totalCount nodes { id author{login} body createdAt } }`

const ITEM = `query SidebarItem($id:ID!,$maxComments:Int!,$withComments:Boolean!){ node(id:$id){ ... on ProjectV2Item {
  id isArchived project{ id number owner{ ... on User{ login } ... on Organization{ login } } }
  ${VALUES} content{ __typename
    ... on Issue{ ${contentFields(100)} id body updatedAt viewerCanUpdate viewerCanClose viewerCanReopen author{login} ${COMMENTS} }
    ... on PullRequest{ ${contentFields(100)} id body updatedAt author{login} ${COMMENTS} }
    ... on DraftIssue{ id title body updatedAt assignees(first:30){nodes{login}} }
  }
} } }`

const REPO_CHOICES = `query SidebarRepository($owner:String!,$repo:String!,$search:String){
  repository(owner:$owner,name:$repo){
    assignees:assignableUsers(first:30,query:$search){ nodes{ login } }
    labels(first:30,query:$search){ nodes{ name } }
    milestones(first:30,query:$search){ nodes{ number title } }
  }
}`

const nodes = (connection) => (connection?.nodes ?? []).filter(Boolean)

function fieldsOf(raw) {
  const options = raw.options ?? raw.multiOptions ?? []
  const iterations = [...(raw.configuration?.iterations ?? []), ...(raw.configuration?.completedIterations ?? [])]
  return {
    id: raw.id, name: raw.name, type: raw.dataType, issueField: raw.isIssueField === true,
    options: [...options, ...iterations.map(({ id, title }) => ({ id, name: title }))],
  }
}

function itemValues(raw) {
  return Object.fromEntries(nodes(raw.fieldValues).filter(value => value.field?.id).map(value => {
    const actual = value.optionId ?? value.iterationId ?? value.text ?? value.number ?? value.date ?? value.choices?.map(choice => choice.id)
    return [value.field.id, actual ?? null]
  }))
}

export function createSidebarGithub({ graphql, rest, GhError, parseRepo, normalizeItem, maxItems, maxComments }) {
  function projectOf(data) {
    const project = data?.repositoryOwner?.projectV2
    if (!project) throw new GhError('project-not-found', '找不到该项目，或当前账号无权访问')
    return project
  }

  function normalize(raw) {
    const content = raw.content
    return {
      ...normalizeItem(raw), inaccessible: !content,
      assignees: nodes(content?.assignees).map(user => user.login),
      milestoneNumber: content?.milestone?.number ?? null, values: itemValues(raw),
      valuesTruncated: raw.fieldValues?.pageInfo?.hasNextPage === true,
    }
  }

  async function layout({ owner, number }) {
    const raw = projectOf(await graphql(LAYOUT, { owner, number }))
    const views = nodes(raw.views).map(view => ({
      id: view.id, number: view.number, name: view.name, layout: view.layout, filter: view.filter ?? '',
      fields: nodes(view.fields).map(field => field.id), columns: nodes(view.verticalGroupByFields).map(field => field.id),
      groups: nodes(view.groupByFields).map(field => field.id),
      sorts: nodes(view.sortByFields).map(sort => ({ fieldId: sort.field.id, direction: sort.direction })),
    }))
    return {
      project: { id: raw.id, title: raw.title, url: raw.url, viewerCanUpdate: raw.viewerCanUpdate === true },
      fields: nodes(raw.fields).map(fieldsOf), views,
      repositories: nodes(raw.repositories).map(repository => repository.nameWithOwner),
      truncated: raw.fields?.pageInfo?.hasNextPage === true || raw.views?.pageInfo?.hasNextPage === true,
    }
  }

  async function items({ owner, number }, filter) {
    let cursor = null
    let total = 0
    const rows = []
    do {
      const limit = Math.min(50, maxItems - rows.length)
      const data = await graphql(ITEMS, { owner, number, filter, limit, cursor })
      const page = projectOf(data).items
      total = page.totalCount
      rows.push(...nodes(page).map(normalize))
      const next = page.pageInfo?.endCursor
      cursor = page.pageInfo?.hasNextPage && next && next !== cursor ? next : null
    } while (cursor && rows.length < maxItems)
    return { items: rows, total, truncated: Boolean(cursor) || total > rows.length }
  }

  async function item({ owner, number }, id, withComments = false) {
    const raw = (await graphql(ITEM, { id, withComments, maxComments }))?.node
    if (!raw?.project || raw.project.owner?.login?.toLowerCase() !== owner.toLowerCase() || raw.project.number !== number) {
      throw new GhError('item-not-found', '此条目不属于当前项目，或无法访问')
    }
    const content = raw.content
    return {
      ...normalize(raw), contentId: content?.id, projectId: raw.project.id, archived: raw.isArchived === true,
      body: content?.body ?? '', author: content?.author?.login ?? null, updatedAt: content?.updatedAt ?? '',
      canEdit: content?.viewerCanUpdate === true,
      canChangeState: (content?.state === 'CLOSED' ? content.viewerCanReopen : content?.viewerCanClose) === true,
      labelsTruncated: (content?.labels?.totalCount ?? 0) > nodes(content?.labels).length,
      assigneesTruncated: (content?.assignees?.totalCount ?? 0) > nodes(content?.assignees).length,
      commentCount: content?.comments?.totalCount ?? 0,
      comments: nodes(content?.comments).map(comment => ({ ...comment, author: comment.author?.login ?? null })),
    }
  }

  async function choices(repo, search) {
    const target = parseRepo(repo)
    if (!target) throw new GhError('bad-request', '请输入 owner/repository')
    const result = (await graphql(REPO_CHOICES, { owner: target.owner, repo: target.name, search: search || null }))?.repository
    if (!result) throw new GhError('issue-not-found', '无法读取该仓库')
    return {
      assignees: nodes(result.assignees).map(({ login }) => login),
      labels: nodes(result.labels).map(({ name }) => name),
      milestones: nodes(result.milestones),
    }
  }

  async function mutation(action, input, output) {
    const type = `${action[0].toUpperCase()}${action.slice(1)}Input`
    const result = await graphql(`mutation SidebarWrite($input:${type}!){ ${action}(input:$input){ ${output} } }`, { input })
    if (!result?.[action]) throw new GhError('gh-failed', 'GitHub 未确认操作结果')
    return result[action]
  }

  return { layout, items, item, detail: (target, id) => item(target, id, true), choices, mutation, rest }
}
