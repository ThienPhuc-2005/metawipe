// Bảng metadata: từng trường kèm mức rủi ro (tô màu) và link bản đồ cho GPS.

import {Badge} from '@astryxdesign/core/Badge';
import {Link} from '@astryxdesign/core/Link';
import {Table, pixel, proportional} from '@astryxdesign/core/Table';
import {Text} from '@astryxdesign/core/Text';
import type {MetadataField} from '../lib/types';
import {RISK_META, RISK_ORDER} from './meta';

interface FieldRow extends Record<string, unknown> {
  id: string;
  risk: MetadataField['risk'];
  group: string;
  tag: string;
  value: string;
  mapUrl?: string;
}

export function InspectorTable({fields}: {fields: MetadataField[]}) {
  const rows: FieldRow[] = [...fields]
    .sort((a, b) => RISK_ORDER.indexOf(a.risk) - RISK_ORDER.indexOf(b.risk))
    .map(f => ({id: f.id, risk: f.risk, group: f.group, tag: f.tag, value: f.value, mapUrl: f.mapUrl}));

  return (
    <Table<FieldRow>
      data={rows}
      idKey="id"
      density="compact"
      textOverflow="wrap"
      columns={[
        {
          key: 'risk',
          header: 'Mức rủi ro',
          width: pixel(130),
          renderCell: row => (
            <Badge variant={RISK_META[row.risk].variant} label={RISK_META[row.risk].label} />
          ),
        },
        {key: 'group', header: 'Nhóm', width: pixel(80)},
        {key: 'tag', header: 'Trường', width: proportional(1)},
        {
          key: 'value',
          header: 'Giá trị',
          width: proportional(2),
          renderCell: row =>
            row.mapUrl ? (
              <Text type="body">
                {row.value}{' '}
                <Link href={row.mapUrl} isExternalLink>
                  Xem trên bản đồ
                </Link>
              </Text>
            ) : (
              row.value
            ),
        },
      ]}
    />
  );
}
