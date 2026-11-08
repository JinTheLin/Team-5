import React from 'react'
import ReactDOM from 'react-dom/client'
import Root from './Root'
import { AuthProvider } from './account'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider><Root /></AuthProvider>
  </React.StrictMode>,
)
