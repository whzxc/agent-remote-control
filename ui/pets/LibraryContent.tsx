import type { ComponentProps } from 'react';
import './LibraryContent.css';
const variants={page:'pets-page',group:'pet-group',import:'pet-import',package:'pet-package'};
export function LibraryContent({as:Element='div',variant,className='',...props}:ComponentProps<'div'>&{as?:'div'|'section'|'article';variant:keyof typeof variants}){return <Element {...props} className={variants[variant]+' '+className}/>;}
