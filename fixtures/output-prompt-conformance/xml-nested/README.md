# xml-nested

XML with a nested OBJECT field. Same as json-nested in XML: the renderer emits a
flat `<name>{name}</name>`-style placeholder rather than expanding the nested
object (documented FR-010 deferral). `roundTrip: false`.
