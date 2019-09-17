import next from 'next'
import { format, parse, UrlWithParsedQuery } from 'url'
import Server from 'next-server/dist/server/next-server'
import { Middleware, BaseContext, Context } from 'koa'
import { extname } from 'path'
import { ParsedUrlQuery } from 'querystring'
import delegates from 'delegates'
import deferred from './deferred'

declare module 'http' {
  interface IncomingMessage {
    context: BaseContext
  }
  interface ServerResponse {
    context: BaseContext
    locals: any
  }
}

declare module 'koa' {
  interface BaseContext extends NextRequest {
    render: (view: string, data?: any, parsed?: UrlWithParsedQuery) => Promise<any>
    renderError: (error: Error | null, data?: any, parsed?: UrlWithParsedQuery) => Promise<any>
    render404: (parsed?: UrlWithParsedQuery) => Promise<any>
    renderToHTML: (view: string, data?: any) => Promise<any>
    renderErrorToHTML: (err: any, data?: any) => Promise<any>
    renderRedirect: (url?: RedirectUrl) => Promise<any>
    handleNext: (parsed?: UrlWithParsedQuery) => Promise<any>
  }
  interface NextRequest {
    buildId: string
    nextApp: NextApp
  }
  interface BaseRequest extends NextRequest {}
  interface BaseResponse {
    _explicitStatus?: number
  }
}

const isProd = process.env.NODE_ENV === 'production'
const featureSymbol = Symbol('koa-next')

export interface PublicConfig {}

export interface ServerConfig {}

export interface NextConfig {
  useFileSystemPublicRoutes?: boolean
  publicRuntimeConfig?: PublicConfig
  runtimeConfig?: ServerConfig
  assetPrefix?: string
}

export interface KoaNextStaticOptions {
  extentions?: string[]
  allowOriginExtentions?: string[]
  allowOriginRegex?: RegExp[]
}

export interface KoaNextOptions extends KoaNextStaticOptions {
  name?: string
  dev?: boolean
  quiet?: boolean
  conf?: any
  dir?: string
}

export interface NextApp extends Server {
  nextConfig: NextConfig
  middleware: Middleware<any, Context>
}

export type RedirectUrl = UrlWithParsedQuery & { back?: boolean; asPath?: string } | string

/**
 * a next.js middleware for koa
 * features:
 * 1. support ctx.render / ctx.renderError / ctx.render404 / ctx.handleNext
 * 2. render data can be read through fetchState(ctx)
 * 3. support fetchState inside getInitialProps when rendered on client side
 */
export default function KoaNext(options: KoaNextOptions = {}): NextApp {
  const opt = {
    dev: !isProd,
    quiet: !isProd,
    ...options,
  }

  // middleware which handles all matched static files of next.js directly in koa router
  const {
    extentions = ['.js', '.css', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.map'],
    allowOriginExtentions = ['.js', '.css'],
    allowOriginRegex = [/.*/],
  } = options

  const app = next(opt) as NextApp
  const handle = app.getRequestHandler()

  // webpack build or read config
  // app.prepare().then(() => def.resolve(app), def.reject)
  const {
    nextConfig: { assetPrefix = '', useFileSystemPublicRoutes = true },
    buildId,
  } = app

  const deferApp = deferred<void>()
  app.prepare().then(deferApp.resolve)

  app.middleware = async (ctx, next) => {
    // 需要增加一个限流降级操作防止，重启的时候，出现请求堆积
    // TODO

    await deferApp.promise

    // 为 context prototype patch NextJs 的 render 方法以及一些特定变量
    patchContextPrototype(ctx, app, buildId)

    // bind ctx.request and ctx.response to ctx.req and ctx.res
    ctx.req.context = ctx
    ctx.res.context = ctx

    try {
      if (ctx.path.match(/^\/(static|_next)\//)) {
        const ext = extname(ctx.path).replace(/\?.*$/, '')
        const originalUrl = ctx.originalUrl
        const isOnDemandEntriesPing = !isProd && originalUrl.indexOf('/_next/on-demand-entries-ping/') === 0
        const isStaticImages = originalUrl.indexOf('/_next/static/images/') === 0

        if (extentions.includes(ext) || isOnDemandEntriesPing) {
          if (assetPrefix.match(/^https?:\/\//) && (allowOriginExtentions.includes(ext) || isOnDemandEntriesPing)) {
            // 增加跨域支持
            ctx.vary('Origin')
            const origin = ctx.get('Origin')
            if (origin && allowOriginRegex.some(item => origin.match(item))) {
              // 跨域请求
              ctx.set('Access-Control-Allow-Origin', origin)
            }
          }
          // next-images cannot set Cache-Control in the right next.js directory
          // workaround the /_next/static/images directory
          if (isStaticImages) {
            ctx.set('Cache-Control', 'public, max-age=31536000, immutable')
          }

          // handle static files and return
          return await ctx.handleNext()
        }

        // unsupported extentions
        return await ctx.render404()
      }

      // make next
      await next()

      if (!isResponded(ctx)) {
        if (useFileSystemPublicRoutes) {
          await ctx.handleNext()
        } else {
          await ctx.render404()
        }
      }
    } catch (e) {
      if (!isResponded(ctx)) {
        await ctx.renderError(e)
      } else {
        throw e
      }
    }
  }

  app.prepare = () => deferApp.promise

  return app

  function patchContextPrototype(ctx: Context, nextApp: NextApp, buildId: string) {
    const context = ctx.app.context
    const request = ctx.app.request
    if (!request.hasOwnProperty(featureSymbol)) {
      Object.assign(context, {
        render,
        renderError,
        render404,
        renderToHTML,
        renderErrorToHTML,
        renderRedirect,
        handleNext,
      })
      Object.defineProperties(request, {
        nextApp: {
          value: nextApp,
          writable: false,
        },
        buildId: {
          value: buildId,
          writable: false,
        },
        [featureSymbol]: {
          value: 'next-koa',
          writable: false,
        },
      })
      delegates(context as Context, 'request')
        .getter('buildId')
        .getter('nextApp')
    }
  }

  type Func = (ctx: Context, query: any, parsedUrl?: UrlWithParsedQuery) => any

  async function fixCtxUrl<T extends {} = any>(ctx: Context, data: T, parsed?: UrlWithParsedQuery | Func, fn?: Func) {
    let func: Func | undefined
    let parsedUrl: UrlWithParsedQuery | undefined

    if (!fn) {
      func = parsed as Func
    } else {
      func = fn
      parsedUrl = parsed as UrlWithParsedQuery
    }

    parsedUrl = parsedUrl || parse(ctx.originalUrl || ctx.url, true)

    const originalUrl = ctx.url
    ctx.url = parsedUrl.path || ''

    ctx.state = ctx.res.locals = { ...ctx.state, ...data }
    try {
      return await func(ctx, { ...ctx.query }, parsedUrl)
    } finally {
      ctx.url = originalUrl
    }
  }

  function isNextFetch(ctx: Context) {
    ctx.vary('X-Requested-With')
    return ctx.get('X-Requested-With') === 'Next-Fetch' && ['HEAD', 'GET'].includes(ctx.method)
  }

  function isResponded(ctx: Context) {
    return (
      ctx.headerSent ||
      !ctx.writable ||
      ctx.respond === false ||
      !!ctx.response._explicitStatus ||
      ctx.response.status !== 404
    )
  }

  function isResSent(ctx: Context) {
    return ctx.headerSent || !ctx.writable
  }

  // render 到 HTML string
  function renderToHTML(this: Context, view: string, data: any = {}) {
    return fixCtxUrl(this, data, ({ req, res }: Context, query: ParsedUrlQuery) =>
      app.renderToHTML(req, res, view, query),
    )
  }

  // ender _error 到 HTML string
  function renderErrorToHTML(this: Context, err: any, data: any = {}) {
    return fixCtxUrl(this, data, ({ req, res }: Context, query: ParsedUrlQuery) =>
      app.renderErrorToHTML(err, req, res, '/_error', query),
    )
  }

  // ender View 并响应到 Response
  function render(this: Context, view: string, data?: any, parsed?: UrlWithParsedQuery) {
    return fixCtxUrl(this, data, parsed, async (ctx, query, parsedUrl) => {
      if (!ctx.response._explicitStatus) {
        ctx.status = 200
      }
      if (isNextFetch(ctx)) {
        ctx.body = data
      } else {
        await app.render(ctx.req, ctx.res, view, query, parsedUrl)
        if (isResSent(ctx)) {
          ctx.respond = false
        }
      }
    })
  }

  // render a 404 using _error view
  function render404(this: Context, parsed?: UrlWithParsedQuery) {
    return fixCtxUrl(this, {}, parsed, async (ctx, _query, parsedUrl) => {
      ctx.status = 404
      if (isNextFetch(ctx)) {
        ctx.body = { message: 'Not Found' }
      } else {
        await app.render404(ctx.req, ctx.res, parsedUrl)
        if (isResSent(ctx)) {
          ctx.respond = false
        }
      }
    })
  }

  // render _error 并响应到 Response
  function renderError(this: Context, error: Error | null, data: any = {}, parsed?: UrlWithParsedQuery) {
    const err = error as any
    return fixCtxUrl(this, data, parsed, async (ctx, query) => {
      if (!ctx.response._explicitStatus) {
        ctx.status = (err && (err.status || err.statusCode)) || 500
      }
      if (isNextFetch(ctx)) {
        if (err) {
          ctx.body = {
            message:
              ((err.expose || options.dev) && (err.message || err.name)) || ctx.message || 'Server Internal Error',
            code: ((err.expose || options.dev) && err.code) || undefined,
            stack: (options.dev && err.stack) || undefined,
            ...data,
          }
        } else {
          ctx.body = data
        }
      } else {
        await app.renderError(error, ctx.req, ctx.res, '/_error', query)
        if (isResSent(ctx)) {
          ctx.respond = false
        }
      }
    })
  }

  // render redirect page which supports next-fetch
  function renderRedirect(this: Context, url: RedirectUrl = '/') {
    const ctx = this

    let parsedUrl: RedirectUrl = url
    let back

    // go back location
    if ('back' === url) {
      parsedUrl = ctx.get('referrer') || '/'
      back = true
    }

    if (typeof parsedUrl === 'string') {
      parsedUrl = parse(url as string, true)
    }

    if (back) {
      parsedUrl.back = back
    }

    const { asPath, pathname } = parsedUrl
    const realParsedUrl: UrlWithParsedQuery = {
      ...parsedUrl,
      pathname: asPath || pathname,
    }

    const realUrl = format(realParsedUrl)

    if (isNextFetch(ctx)) {
      ctx.status = 200
      ctx.set('Content-Location', realUrl)
      ctx.body = parsedUrl
    } else {
      ctx.redirect(realUrl)
    }
  }

  // handle all NextJs logic, like static files serve or routes resolution
  function handleNext(this: Context, parsed?: UrlWithParsedQuery) {
    return fixCtxUrl(this, {}, parsed, async (ctx, _query, parsedUrl) => {
      await handle(ctx.req, ctx.res, parsedUrl)
      if (isResSent(ctx)) {
        ctx.respond = false
      }
    })
  }
}

// Support commonjs `require('koa-next')`
module.exports = KoaNext
