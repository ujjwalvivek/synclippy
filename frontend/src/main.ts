import app from './app.svelte'
import './index.css'

const App = new app({
  target: document.getElementById('root')!,
})

export default App
