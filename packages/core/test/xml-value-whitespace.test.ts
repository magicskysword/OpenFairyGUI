import test from 'ava';
import { parseXML, parseXMLPreserveOrder } from '../src/utils/xml-utils.js';

test('XML attribute values preserve significant leading and trailing whitespace', (t) => {
	const xml =
		'<component name=" panel "><controller name="quality " pages="0,默认,1, " /><displayList><text id="t1" name=" title" text="　　描述 &#xA; "/></displayList></component>';
	const root = (
		parseXML(xml).component as Array<{
			name: string;
			controller: Array<{ name: string; pages: string }>;
			displayList: { text: Array<{ name: string; text: string[] }> };
		}>
	)[0];
	t.is(root.name, ' panel ');
	t.is(root.controller[0].name, 'quality ');
	t.is(root.controller[0].pages, '0,默认,1, ');
	t.is(root.displayList.text[0].name, ' title');
	t.deepEqual(root.displayList.text[0].text, ['　　描述 \n ']);
	const ordered = parseXMLPreserveOrder(xml);
	t.is((ordered[0][':@'] as Record<string, string>).name, ' panel ');
});
