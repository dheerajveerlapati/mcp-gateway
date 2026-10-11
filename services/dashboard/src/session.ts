import { createContext, useContext } from 'react'
import type { Me } from './api'

// The logged-in person, available to every page via useMe().
export const MeContext = createContext<Me | null>(null)

export function useMe(): Me {
  const me = useContext(MeContext)
  if (!me) throw new Error('useMe() used outside a logged-in page')
  return me
}
