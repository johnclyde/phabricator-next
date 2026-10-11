# Test-only deterministic package fixture; requires python-docx.
# Runtime DOCX processing is implemented in TypeScript.
from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.shared import RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED, ZipInfo
from io import BytesIO

out=Path(__file__).with_name('roundtrip.docx')
doc=Document()
doc.add_heading('Document review fixture', 0)
style=doc.styles.add_style('ReviewHeading', WD_STYLE_TYPE.PARAGRAPH)
style.base_style=doc.styles['Heading 1']
doc.add_paragraph('Findings and evidence', style='ReviewHeading')
p=doc.add_paragraph(); p.add_run('The original result is clear.').bold=True
p=doc.add_paragraph('A note supports this statement. ')
r=OxmlElement('w:r'); ref=OxmlElement('w:footnoteReference');ref.set(qn('w:id'),'2');r.append(ref);p._p.append(r)
p=doc.add_paragraph(); start=OxmlElement('w:commentRangeStart');start.set(qn('w:id'),'7');p._p.append(start);p.add_run('This passage has a reviewer comment.');end=OxmlElement('w:commentRangeEnd');end.set(qn('w:id'),'7');p._p.append(end);r=OxmlElement('w:r');ref=OxmlElement('w:commentReference');ref.set(qn('w:id'),'7');r.append(ref);p._p.append(r)
p=doc.add_paragraph('Existing tracked proposal: ')
for name,text,num in [('del','old wording',10),('ins','new wording',11)]:
    mark=OxmlElement('w:'+name);mark.set(qn('w:id'),str(num));mark.set(qn('w:author'),'Imported Reviewer');mark.set(qn('w:date'),'2025-01-02T03:04:05Z');r=OxmlElement('w:r');t=OxmlElement('w:delText' if name=='del' else 'w:t');t.text=text;r.append(t);mark.append(r);p._p.append(mark)
doc.add_paragraph('Unchanged tail and typography.')
for style in doc.styles:
    if style.type == WD_STYLE_TYPE.PARAGRAPH:
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.font.underline = False
        for border in list(style.element.iter(qn('w:pBdr'))):
            border.getparent().remove(border)
for paragraph in doc.paragraphs:
    for border in list(paragraph._p.iter(qn('w:pBdr'))):
        border.getparent().remove(border)
buf=BytesIO();doc.save(buf)
with ZipFile(BytesIO(buf.getvalue())) as z: parts={n:z.read(n) for n in z.namelist()}
w='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
parts['word/footnotes.xml']=f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes xmlns:w="{w}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Source note with exact wording.</w:t></w:r></w:p></w:footnote></w:footnotes>'''.encode()
parts['word/comments.xml']=f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="{w}"><w:comment w:id="7" w:author="Imported Reviewer" w:initials="IR" w:date="2025-01-02T03:04:05Z"><w:p><w:r><w:t>Please preserve this comment.</w:t></w:r></w:p></w:comment></w:comments>'''.encode()
rels=parts['word/_rels/document.xml.rels'].decode().replace('</Relationships>','<Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/><Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>');parts['word/_rels/document.xml.rels']=rels.encode()
ct=parts['[Content_Types].xml'].decode().replace('</Types>','<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Default Extension="bin" ContentType="application/octet-stream"/></Types>');parts['[Content_Types].xml']=ct.encode()
# Opaque XML and binary entries are preserved even without semantic support.
parts['custom/unknown.xml']=b'<?xml version="1.0"?><extension xmlns="urn:roundtrip:test" unusual="  keep  "><payload><![CDATA[x < y & z]]></payload></extension>'
parts['custom/unknown.bin']=bytes(range(256))
xml=parts['word/document.xml'].decode().replace('<w:body>','<w:body><!-- lexical sentinel remains exactly here -->',1)
parts['word/document.xml']=xml.encode()
with ZipFile(out,'w',ZIP_DEFLATED,compresslevel=6) as z:
    for name,data in parts.items():
        info=ZipInfo(name,(2000,1,1,0,0,0));info.compress_type=ZIP_DEFLATED;info.external_attr=0o100644<<16;z.writestr(info,data)
print(out)
