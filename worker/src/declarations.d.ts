// ? Allow importing raw text files
// * bundled by Wrangler via [[rules]]
declare module '*.txt' {
  const content: string
  export default content
}
