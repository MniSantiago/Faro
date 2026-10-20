import ReactMarkdown from 'react-markdown';
import { safeUrl } from '../markdown';

/** Markdown de un mensaje: sin HTML crudo ni imágenes, enlaces http(s) en otra pestaña. */
export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      skipHtml
      disallowedElements={['img']}
      unwrapDisallowed
      urlTransform={(url) => safeUrl(url)}
      components={{ a: ({ href, children }) => (href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>) }}
    >
      {text}
    </ReactMarkdown>
  );
}
