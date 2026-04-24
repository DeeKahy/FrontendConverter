// Barrel module — importing this registers every built-in converter.
//
// To add a new format, create src/converters/<your-module>.js and import it
// from here. That's it. The UI picks up new converters automatically.

import './image.js';
import './svg.js';
import './text.js';
import './pdf.js';
import './media.js';
