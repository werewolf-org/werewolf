import './index.css'
import { render } from './router'
import { socketService } from './socket.service'
import { installClientDebugHooks } from './debug-report'

// Before the socket exists: a failure during boot is exactly what must end up in the report.
installClientDebugHooks()

// Initialize socket connection (this triggers the Render cold-start if needed)
socketService.connect()

window.addEventListener('hashchange', () => {
  render()
})

document.addEventListener('DOMContentLoaded', () => {
  if (!window.location.hash) {
    window.location.hash = '#/'
  } else {
    render()
  }
})