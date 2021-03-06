import React from 'react'

export interface LayoutProps {
  children: React.ReactNode
}

const layoutMap = new Map<React.ComponentType<any>, Array<React.ComponentType<LayoutProps>>>()

/**
 * ### Make a layout HOC for next page
 * this hoc function can setup multiple layouts shared\
 * between pages, the layout won't be unmount\
 * when pages are switched between each other
 *
 * you can do this as following steps:\
 * first create your page with HOC
 * ```
 * // pages/Login.tsx
 * import Layout from './layout/LoginLayout'
 *
 * const LoginPage: React.FC = ...
 * export default withLayout(Layout)(LoginPage)
 * ```
 * and then extends your next App from `next-koa/app`
 * ```
 * // pages/_app.tsx
 * import App from 'next-koa/app'
 * export default class MyApp extends App {
 *   ...
 * }
 * ```
 * and make sure your next.config.js is using `next-koa/plugin`
 * ```
 * // next.config.js
 * const withNextKoaPlugin = require('next-koa/plugin')
 * module.exports = withNextKoaPlugin({
 *   // ...config
 * })
 * ```
 * if the layout Component is too big, and you want to import\
 * it on demond, you can create a LayoutModel.ts like below
 * ```
 * // layout/LayoutModel.ts
 * // provider all dynamic layout HOC reference
 * import dynamic from 'next/dynamic'
 * import { withLayout } from 'next-koa/layout'
 * export const withLoginLayout = withLayout(dynamic(() => import('./layout/LoginLayout')))
 * ```
 * then you can import that HOC
 * ```
 * // pages/_Login.tsx
 * import { withLoginLayout } from '../layout/LayoutModel'
 * ...
 * export default withLoginLayout(LoginPage)
 * ```
 * * be sure that layout HOC is decorated exactly upon the exported pages
 * * withLayout can receive multiple layouts as a layout stack
 * @param layout the Layout component
 */
export function withLayout(...layout: Array<React.ComponentType<LayoutProps>>) {
  // tslint:disable-next-line: only-arrow-functions
  return function<C>(page: React.ComponentType<C>) {
    const layouts = layoutMap.get(page)
    if (layouts) {
      layouts.push(...layout)
    } else {
      layoutMap.set(page, layout)
    }
    return page
  }
}

export interface PageLayoutProps<T = any> {
  component: React.ComponentType<T>
  pageProps: T
}

const Layout: React.FC<PageLayoutProps> = ({ component: Component, pageProps }) => {
  const layouts = layoutMap.get(Component)
  const children = <Component {...pageProps} />
  if (layouts && layouts.length) {
    return layouts.reduce((children, ComponentLayout) => <ComponentLayout>{children}</ComponentLayout>, children)
  }
  return children
}

export default Layout
