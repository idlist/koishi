import { Context, pick, version as coreVersion } from 'koishi-core'
import { dirname, resolve } from 'path'
import { existsSync, promises as fs } from 'fs'
import { spawn, StdioOptions } from 'child_process'
import { satisfies } from 'semver'
import axios from 'axios'

interface PackageBase {
  name: string
  version: string
  description: string
}

interface PackageJson extends PackageBase {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

interface PackageLocal extends PackageJson {
  private?: boolean
}

interface PackageRemote extends PackageJson {
  dist: {
    unpackedSize: number
  }
}

interface SearchResult {
  results: any[]
}

interface Registry extends PackageBase {
  versions: Record<string, PackageRemote>
}

const officialPlugins = [
  'adventure', 'assets', 'chat', 'chess', 'common', 'dice',
  'eval', 'github', 'image-search', 'mongo', 'mysql',
  'puppeteer', 'schedule', 'teach', 'tools', 'webui',
]

type Manager = 'yarn' | 'npm'

const cwd = process.cwd()

function execute(bin: string, args: string[] = [], stdio: StdioOptions = 'inherit') {
  // fix for #205
  // https://stackoverflow.com/questions/43230346/error-spawn-npm-enoent
  const child = spawn(bin + (process.platform === 'win32' ? '.cmd' : ''), args, { stdio })
  return new Promise<number>((resolve) => {
    child.on('close', resolve)
  })
}

let _managerPromise: Promise<Manager>
async function getManager(): Promise<Manager> {
  if (existsSync(resolve(cwd, 'yarn.lock'))) return 'yarn'
  if (existsSync(resolve(cwd, 'package-lock.json'))) return 'npm'
  if (!await execute('yarn', ['--version'], 'ignore')) return 'yarn'
  return 'npm'
}

const installArgs: Record<Manager, string[]> = {
  yarn: ['add'],
  npm: ['install', '--loglevel', 'error'],
}

class Awesome {
  cached: Promise<Awesome.PackageData[]>

  constructor(private ctx: Context, public config: Awesome.Config) {
    ctx.router.get(config.apiPath + '/package(/.+)+', async (ctx) => {
      const name = ctx.path.slice(config.apiPath.length + 9)
      const { data } = await axios.get(`https://registry.npmjs.org/${name}`)
      ctx.body = data
      ctx.set('Access-Control-Allow-Origin', '*')
    })
  }

  async get(forced = false) {
    if (this.cached && !forced) return this.cached
    return this.cached = this.getForced()
  }

  private async getForced() {
    const _loadDep = async (filename: string, isInstalled: boolean) => {
      do {
        filename = dirname(filename)
        const files = await fs.readdir(filename)
        if (files.includes('package.json')) break
      } while (true)
      const data: PackageLocal = JSON.parse(await fs.readFile(filename + '/package.json', 'utf8'))
      if (data.private) return null
      const isWorkspace = !filename.includes('node_modules')
      return { isWorkspace, isInstalled, ...pick(data, ['name', 'version', 'description']) }
    }

    const loadCache: Record<string, Promise<Awesome.PackageMeta>> = {}
    const loadDep = (filename: string, isInstalled: boolean) => {
      return loadCache[filename] ||= _loadDep(filename, isInstalled)
    }

    const [{ data }] = await Promise.all([
      axios.get<SearchResult>('https://api.npms.io/v2/search?q=koishi-plugin+not:deprecated&size=250'),
      Promise.all(Object.keys(require.cache).map((filename) => {
        const { exports } = require.cache[filename]
        if (this.ctx.app.registry.has(exports)) return loadDep(filename, true)
      })),
    ])

    const loadExternal = (name: string) => {
      try {
        const filename = require.resolve(name)
        return loadDep(filename, false)
      } catch {}
    }

    return Promise.all(data.results.map(async (item) => {
      const { name, version } = item.package
      const official = officialPlugins.includes(name.slice(14))
      const [local, { data }] = await Promise.all([
        loadExternal(name),
        axios.get<Registry>(`https://registry.npmjs.org/${name}`),
      ])
      const { dependencies = {}, peerDependencies = {}, dist } = data.versions[version]
      const core = { ...dependencies, ...peerDependencies }['koishi-core']
      if (!core || !satisfies(coreVersion, core)) return

      return {
        ...item.package,
        local,
        official,
        size: dist.unpackedSize,
        score: {
          final: item.score.final,
          ...item.score.detail,
        },
      } as Awesome.PackageData
    })).then(data => data.filter(Boolean))
  }

  async install(name: string) {
    const kind = await (_managerPromise ||= getManager())
    const args = [...installArgs[kind], name]
    await execute(kind, args)
    this.ctx.webui.broadcast('awesome', await this.get(true))
  }
}

namespace Awesome {
  export interface Config {
    apiPath?: string
  }

  export interface PackageMeta extends PackageBase {
    isWorkspace: boolean
    isInstalled: boolean
  }

  export interface PackageData extends PackageBase {
    local?: PackageMeta
    official: boolean
    size: number
    score: {
      final: number
      quality: number
      popularity: number
      maintenance: number
    }
  }
}

export default Awesome
